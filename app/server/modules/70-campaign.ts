// Campaign module: acts, quests, sessions, narrative threads, handouts, GM notes, player recap.
// Seeds: data/seed/campaign.json, then every data/seed/campaign/*.json (sorted, later files override
// fields of the same id). Seed items are only added when missing; an item the GM never touched is
// refreshed when its seed changes (tracked with hashes in campaign._seed), GM edits are never overwritten.
import fs from 'node:fs';
import path from 'node:path';
import type {
  ActionContext, Campaign, CampaignAct, CampaignSession, CampaignThread, Handout, InitOptions, PlayerCampaignView, Quest, QuestPhase,
  QuestStatus, ServerEvents, ServerModule, TableState, ThreadState, UserId,
} from '../../shared/types.ts';

/** Raw item of a seed file or of a client payload: every field is sanitized by the normalizers. */
type Raw = Record<string, unknown>;
/** Id generator (`ctx.uid` or localUid at boot). */
type Uid = (prefix: string) => string;
/** Item type of each campaign collection. */
interface CollectionItems {
  acts: CampaignAct;
  quests: Quest;
  sessions: CampaignSession;
  threads: CampaignThread;
  handouts: Handout;
}
type CollectionKey = keyof CollectionItems;
type TextKey = 'playerRecap' | 'notes';
/** A merged seed document (mergeSeeds): raw collections + texts. */
type CampaignSeed = { [K in CollectionKey]: Raw[] } & Partial<Record<TextKey, string>>;

export const QUEST_STATUS: QuestStatus[] = ['upcoming', 'active', 'done', 'skipped'];
export const THREAD_STATES: ThreadState[] = ['open', 'dormant', 'resolved', 'dead'];
const COLLECTIONS: CollectionKey[] = ['acts', 'quests', 'sessions', 'threads', 'handouts'];
const TEXTS: TextKey[] = ['playerRecap', 'notes'];
/** `list.includes(v)` for a value of unknown type (narrows it). */
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => (list as readonly unknown[]).includes(v);

const MAX_TITLE = 200;
const MAX_MD = 200000;
const MAX_IDS = 60;

// ---------------------------------------------------------------------------
// Sanitizers (used for seeds and for every payload coming from the client)
// ---------------------------------------------------------------------------
const str = (v: unknown, max = MAX_TITLE): string => (v === undefined || v === null ? '' : String(v)).slice(0, max);
const md = (v: unknown): string => str(v, MAX_MD);
const cleanId = (v: unknown): string => str(v, 80).trim().replace(/[^\w.\-:]/g, '_');
const idList = (v: unknown): string[] => (Array.isArray(v) ? [...new Set(v.map(cleanId).filter(Boolean))].slice(0, MAX_IDS) : []);
/** 'file.md' or 'file.md#Heading' — basename only. */
function docRef(v: unknown): string {
  const s = str(v, 300).trim();
  if (!s) return '';
  const [file, ...frag] = s.split('#');
  const base = path.basename(file.trim());
  if (!base.toLowerCase().endsWith('.md')) return '';
  return frag.length ? `${base}#${frag.join('#').trim().slice(0, 200)}` : base;
}
function imageUrl(v: unknown): string {
  const s = str(v, 500).trim();
  if (!s) return '';
  return /^(\/(uploads|assets)\/|https?:\/\/)/.test(s) && !/["'<>\s]/.test(s) ? s : '';
}

function normAct(a: Raw = {}, uid: Uid): CampaignAct {
  return { id: cleanId(a.id) || uid('act'), title: str(a.title) || 'New act', summary: md(a.summary) };
}
function normPhase(p: Raw = {}, uid: Uid): QuestPhase {
  return { id: cleanId(p.id) || uid('ph'), title: str(p.title) || 'New phase', text: md(p.text), done: !!p.done };
}
function normQuest(q: Raw = {}, uid: Uid): Quest {
  // Phases without id get a deterministic one (p1, p2…) so seeds hash identically at every boot.
  const phases = Array.isArray(q.phases)
    ? q.phases.slice(0, 50).filter((p) => p && typeof p === 'object').map((p, i) => normPhase({ ...p, id: cleanId(p.id) || `p${i + 1}` }, uid))
    : [];
  // Phase ids must be unique within a quest.
  const seen = new Set<string>();
  for (const p of phases) {
    if (seen.has(p.id)) p.id = uid('ph');
    seen.add(p.id);
  }
  return {
    id: cleanId(q.id) || uid('q'),
    actId: cleanId(q.actId),
    title: str(q.title) || 'New quest',
    status: oneOf(QUEST_STATUS, q.status) ? q.status : 'upcoming',
    summary: md(q.summary),
    phases,
    npcs: idList(q.npcs),
    maps: idList(q.maps),
    rewards: md(q.rewards),
    gmNotes: md(q.gmNotes),
    doc: docRef(q.doc),
  };
}
function normSession(s: Raw = {}, uid: Uid): CampaignSession {
  const n = Math.round(Number(s.number));
  return {
    id: cleanId(s.id) || uid('ses'),
    number: Number.isFinite(n) && n > 0 ? Math.min(n, 9999) : 1,
    title: str(s.title),
    date: str(s.date, 40),
    plan: md(s.plan),
    recap: md(s.recap),
    played: !!s.played,
    doc: docRef(s.doc),
  };
}
function normThread(t: Raw = {}, uid: Uid): CampaignThread {
  return {
    id: cleanId(t.id) || uid('th'),
    label: str(t.label) || 'New thread',
    state: oneOf(THREAD_STATES, t.state) ? t.state : 'open',
    notes: md(t.notes),
  };
}
function revealList(v: unknown): 'all' | UserId[] {
  if (v === 'all') return 'all';
  return idList(v);
}
function normHandout(h: Raw = {}, uid: Uid, now = Date.now()): Handout {
  const out: Handout = {
    id: cleanId(h.id) || uid('ho'),
    title: str(h.title) || 'New handout',
    body: md(h.body),
    image: imageUrl(h.image),
    revealedTo: revealList(h.revealedTo),
    ts: Number(h.ts) || now,
    gmNotes: md(h.gmNotes),
  };
  if (Number(h.revealedAt)) out.revealedAt = Number(h.revealedAt);
  return out;
}
const NORMALIZERS: { [K in CollectionKey]: (raw: Raw, uid: Uid) => CollectionItems[K] } = { acts: normAct, quests: normQuest, sessions: normSession, threads: normThread, handouts: normHandout };

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------
function hash(v: unknown): string {
  const s = JSON.stringify(v ?? null);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') console.warn(`[campaign] seed ignored (${path.basename(file)}): ${e.message}`);
    return null;
  }
}

/** Read campaign.json then campaign/*.json (sorted). */
export function readCampaignSeeds(seedDir: string): unknown[] {
  const out: unknown[] = [];
  const main = readJsonFile(path.join(seedDir, 'campaign.json'));
  if (main) out.push(main);
  const dir = path.join(seedDir, 'campaign');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      const s = readJsonFile(path.join(dir, f));
      if (s) out.push(s);
    }
  }
  return out;
}

/** Merge seed documents in order: collections by id (later files override fields), texts replaced. */
export function mergeSeeds(seeds: unknown[]): CampaignSeed {
  const merged: CampaignSeed = { acts: [], quests: [], sessions: [], threads: [], handouts: [] };
  for (const rawSeed of seeds) {
    if (!rawSeed || typeof rawSeed !== 'object') continue;
    const seed = rawSeed as Raw;
    for (const key of COLLECTIONS) {
      const items = seed[key];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!item || typeof item !== 'object' || !item.id) continue;
        const i = merged[key].findIndex((x) => x.id === item.id);
        if (i >= 0) merged[key][i] = { ...merged[key][i], ...item };
        else merged[key].push({ ...item });
      }
    }
    for (const key of TEXTS) {
      const text = seed[key];
      if (typeof text === 'string') merged[key] = text;
    }
  }
  return merged;
}

/** Apply a merged seed to the campaign slice: add missing, refresh untouched, never overwrite GM edits. */
export function applySeed(campaign: Campaign, seed: Partial<CampaignSeed>, uid: Uid): Campaign {
  const meta = (campaign._seed = campaign._seed && typeof campaign._seed === 'object' ? campaign._seed : ({} as NonNullable<Campaign['_seed']>));
  meta.hashes = meta.hashes || {};
  meta.deleted = Array.isArray(meta.deleted) ? meta.deleted : [];
  const seedTs = Date.UTC(2080, 0, 1);
  for (const key of COLLECTIONS) {
    const list = campaign[key] as Array<{ id: string }>;
    for (const raw of seed[key] || []) {
      const item: { id: string } = key === 'handouts' ? normHandout(raw, uid, seedTs) : NORMALIZERS[key](raw, uid);
      const hk = `${key}:${item.id}`;
      if (meta.deleted.includes(hk)) continue;
      const h = hash(item);
      const i = list.findIndex((x) => x.id === item.id);
      if (i < 0) {
        list.push(item);
        meta.hashes[hk] = h;
      } else if (meta.hashes[hk] && meta.hashes[hk] !== h && hash(list[i]) === meta.hashes[hk]) {
        list[i] = item; // untouched since last seeding: take the newer seed
        meta.hashes[hk] = h;
      }
    }
  }
  for (const key of TEXTS) {
    const text = seed[key];
    if (typeof text !== 'string') continue;
    const hk = `text:${key}`;
    const h = hash(text);
    if (typeof campaign[key] !== 'string' || (campaign[key] === '' && !meta.hashes[hk])) {
      campaign[key] = md(text);
      meta.hashes[hk] = h;
    } else if (meta.hashes[hk] && meta.hashes[hk] !== h && hash(campaign[key]) === meta.hashes[hk]) {
      campaign[key] = md(text);
      meta.hashes[hk] = h;
    }
  }
  return campaign;
}

function ensureSlice(state: TableState, uid: Uid): Campaign {
  const c = (state.campaign = state.campaign && typeof state.campaign === 'object' ? state.campaign : ({} as Campaign));
  // Loose view of the slice while it is sanitized (stored data may be anything).
  const loose = c as unknown as Record<string, unknown>;
  for (const key of COLLECTIONS) {
    const items: Raw[] = Array.isArray(loose[key]) ? (loose[key] as Raw[]).filter((x) => x && typeof x === 'object' && x.id) : [];
    if (key === 'handouts') loose[key] = items.map((h) => normHandout(h, uid));
    else loose[key] = items.map((x) => NORMALIZERS[key](x, uid));
  }
  for (const key of TEXTS) if (typeof c[key] !== 'string') loose[key] = undefined;
  if (c.currentActId !== undefined && typeof c.currentActId !== 'string') c.currentActId = null;
  return c;
}

let fallbackCounter = 0;
const localUid = (p: string): string => `${p}_${Date.now().toString(36)}${(fallbackCounter++).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

// ---------------------------------------------------------------------------
// Helpers for actions
// ---------------------------------------------------------------------------
function camp(ctx: ActionContext): Campaign {
  if (!ctx.state.campaign) ensureSlice(ctx.state, ctx.uid);
  return ctx.state.campaign;
}
// « Not found » error of each collection (whole sentences: translatable keys, tk marks them for tools/i18n-check.ts).
const tk = (s: string): string => s;
const NOT_FOUND: Record<CollectionKey, string> = {
  acts: tk('Act not found'),
  quests: tk('Quest not found'),
  sessions: tk('Session not found'),
  threads: tk('Plot thread not found'),
  handouts: tk('Document not found'),
};
function notFound(ctx: ActionContext, key: CollectionKey): never {
  return ctx.fail(NOT_FOUND[key] || tk('Item not found'));
}
function find<K extends CollectionKey>(ctx: ActionContext, key: K, id: unknown): CollectionItems[K] {
  const item = (camp(ctx)[key] as CollectionItems[K][]).find((x) => x.id === id);
  if (!item) notFound(ctx, key);
  return item;
}
function remove(ctx: ActionContext, key: CollectionKey, id: unknown): { id: string } {
  const c = camp(ctx);
  const list = c[key] as Array<{ id: string }>;
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) notFound(ctx, key);
  const [item] = list.splice(i, 1);
  const hk = `${key}:${id}`;
  // A deleted seed item must not come back at the next boot.
  if (c._seed?.hashes?.[hk] && !c._seed.deleted.includes(hk)) c._seed.deleted.push(hk);
  return item;
}
function move(ctx: ActionContext, key: CollectionKey, id: unknown, dir: unknown): void {
  const list = camp(ctx)[key] as Array<{ id: string }>;
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) notFound(ctx, key);
  const j = i + (Number(dir) < 0 ? -1 : 1);
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}
/** Apply a whitelisted patch through the normalizer (keeps id). */
function patchItem<K extends CollectionKey>(ctx: ActionContext, key: K, item: CollectionItems[K], patch: unknown, allowed: string[]): CollectionItems[K] {
  if (!patch || typeof patch !== 'object') ctx.fail('Invalid change');
  const prev = item as unknown as Raw;
  const next: Raw = { ...prev };
  for (const k of allowed) if (Object.prototype.hasOwnProperty.call(patch, k)) next[k] = (patch as Raw)[k];
  // Invalid enum values are ignored rather than reset to the default.
  if (key === 'quests' && !oneOf(QUEST_STATUS, next.status)) next.status = prev.status;
  if (key === 'threads' && !oneOf(THREAD_STATES, next.state)) next.state = prev.state;
  const norm: { id: string; revealedAt?: number } = NORMALIZERS[key](next, ctx.uid);
  norm.id = item.id;
  if (key === 'handouts' && prev.revealedAt) norm.revealedAt = prev.revealedAt as number;
  Object.assign(item, norm);
  return item;
}
const playerIds = (state: TableState): UserId[] => Object.keys(state.users || {});

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Action payloads
// ---------------------------------------------------------------------------
interface ActPayload {
  actId?: string | null;
  title?: string;
  summary?: string;
  patch?: Raw;
}
interface QuestPayload {
  questId?: string;
  phaseId?: string;
  status?: QuestStatus;
  done?: boolean;
  title?: string;
  text?: string;
  dir?: number;
  patch?: Raw;
}
interface SessionPayload {
  sessionId?: string;
  patch?: Raw;
}
interface ThreadPayload {
  threadId?: string;
  dir?: number;
  patch?: Raw;
}
interface HandoutPayload {
  handoutId?: string;
  /** 'all' or user id(s). */
  to?: 'all' | UserId | UserId[];
  userId?: UserId;
  patch?: Raw;
}
interface TextPayload {
  text?: string;
}

/** A handout was revealed to the player(s). */
const emitHandout = (ctx: ActionContext, to: 'players' | UserId[], data: ServerEvents['campaign/handout']) => ctx.emitTo(to, 'campaign/handout', data);

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------
const mod: ServerModule = {
  name: 'campaign',

  init(state, { seedDir } = {} as InitOptions) {
    const c = ensureSlice(state, localUid);
    let seeds: unknown[] = [];
    try {
      if (seedDir) seeds = readCampaignSeeds(seedDir);
    } catch (err) {
      console.error('[campaign] cannot read seeds:', err);
    }
    applySeed(c, mergeSeeds(seeds), localUid);
    for (const key of TEXTS) if (typeof c[key] !== 'string') c[key] = '';
    if (c.currentActId && !c.acts.some((a) => a.id === c.currentActId)) c.currentActId = null;
    if (c.currentActId === undefined) c.currentActId = null;
  },

  actions: {
    // ----- acts -----
    'campaign/addAct': {
      handler(ctx: ActionContext, { title, summary }: ActPayload = {}) {
        const act = normAct({ title: str(title) || ctx.t('New act'), summary }, ctx.uid); // default title in the table language
        act.id = ctx.uid('act');
        camp(ctx).acts.push(act);
        return act.id;
      },
    },
    'campaign/updateAct': {
      handler(ctx: ActionContext, { actId, patch }: ActPayload = {}) {
        patchItem(ctx, 'acts', find(ctx, 'acts', actId), patch, ['title', 'summary']);
      },
    },
    'campaign/deleteAct': {
      handler(ctx: ActionContext, { actId }: ActPayload = {}) {
        const c = camp(ctx);
        if (c.quests.some((q) => q.actId === actId)) ctx.fail('This act still contains quests');
        remove(ctx, 'acts', actId);
        if (c.currentActId === actId) c.currentActId = null;
      },
    },
    // null = automatic (act of the first active quest)
    'campaign/setCurrentAct': {
      handler(ctx: ActionContext, { actId }: ActPayload = {}) {
        if (actId) find(ctx, 'acts', actId);
        camp(ctx).currentActId = actId || null;
      },
    },

    // ----- quests -----
    'campaign/addQuest': {
      handler(ctx: ActionContext, payload: Raw = {}) {
        const c = camp(ctx);
        const q = normQuest({ ...payload, title: str(payload.title) || ctx.t('New quest'), id: undefined }, ctx.uid);
        q.id = ctx.uid('q');
        if (!q.actId || !c.acts.some((a) => a.id === q.actId)) q.actId = c.acts[0]?.id || '';
        c.quests.push(q);
        return q.id;
      },
    },
    'campaign/updateQuest': {
      handler(ctx: ActionContext, { questId, patch }: QuestPayload = {}) {
        const q = find(ctx, 'quests', questId);
        patchItem(ctx, 'quests', q, patch, ['actId', 'title', 'status', 'summary', 'phases', 'npcs', 'maps', 'rewards', 'gmNotes', 'doc']);
      },
    },
    'campaign/deleteQuest': {
      handler(ctx: ActionContext, { questId }: QuestPayload = {}) {
        remove(ctx, 'quests', questId);
      },
    },
    'campaign/moveQuest': {
      handler(ctx: ActionContext, { questId, dir }: QuestPayload = {}) {
        // Move within the same act: swap with the previous/next quest of that act.
        const list = camp(ctx).quests;
        const q = find(ctx, 'quests', questId);
        const same = list.filter((x) => x.actId === q.actId);
        const k = same.indexOf(q) + (Number(dir) < 0 ? -1 : 1);
        if (k < 0 || k >= same.length) return;
        const i = list.indexOf(q);
        const j = list.indexOf(same[k]);
        [list[i], list[j]] = [list[j], list[i]];
      },
    },
    'campaign/setQuestStatus': {
      handler(ctx: ActionContext, { questId, status }: QuestPayload = {}) {
        if (!oneOf(QUEST_STATUS, status)) return ctx.fail('Invalid status');
        find(ctx, 'quests', questId).status = status;
      },
    },
    'campaign/togglePhase': {
      handler(ctx: ActionContext, { questId, phaseId, done }: QuestPayload = {}) {
        const q = find(ctx, 'quests', questId);
        const p = q.phases.find((x) => x.id === phaseId);
        if (!p) return ctx.fail('Phase not found');
        p.done = typeof done === 'boolean' ? done : !p.done;
        if (p.done && q.status === 'upcoming') q.status = 'active';
        return p.done;
      },
    },
    'campaign/addPhase': {
      handler(ctx: ActionContext, { questId, title, text }: QuestPayload = {}) {
        const q = find(ctx, 'quests', questId);
        if (q.phases.length >= 50) ctx.fail('Too many phases');
        const p = normPhase({ title: str(title) || ctx.t('New phase'), text }, ctx.uid);
        p.id = ctx.uid('ph');
        q.phases.push(p);
        return p.id;
      },
    },
    'campaign/updatePhase': {
      handler(ctx: ActionContext, { questId, phaseId, patch }: QuestPayload = {}) {
        const q = find(ctx, 'quests', questId);
        const p = q.phases.find((x) => x.id === phaseId);
        if (!p) return ctx.fail('Phase not found');
        if (!patch || typeof patch !== 'object') ctx.fail('Invalid change');
        const next = normPhase({ ...p, ...pick(patch as Raw, ['title', 'text', 'done']) }, ctx.uid);
        Object.assign(p, next, { id: p.id });
      },
    },
    'campaign/deletePhase': {
      handler(ctx: ActionContext, { questId, phaseId }: QuestPayload = {}) {
        const q = find(ctx, 'quests', questId);
        const before = q.phases.length;
        q.phases = q.phases.filter((p) => p.id !== phaseId);
        if (q.phases.length === before) ctx.fail('Phase not found');
      },
    },
    'campaign/movePhase': {
      handler(ctx: ActionContext, { questId, phaseId, dir }: QuestPayload = {}) {
        const q = find(ctx, 'quests', questId);
        const i = q.phases.findIndex((p) => p.id === phaseId);
        if (i < 0) ctx.fail('Phase not found');
        const j = i + (Number(dir) < 0 ? -1 : 1);
        if (j < 0 || j >= q.phases.length) return;
        [q.phases[i], q.phases[j]] = [q.phases[j], q.phases[i]];
      },
    },

    // ----- sessions -----
    'campaign/addSession': {
      handler(ctx: ActionContext, payload: Raw = {}) {
        const c = camp(ctx);
        const next = c.sessions.reduce((m, s) => Math.max(m, s.number || 0), 0) + 1;
        const s = normSession({ number: next, title: ctx.t('Session {n}', { n: next }), ...payload, id: undefined, played: false }, ctx.uid);
        s.id = ctx.uid('ses');
        c.sessions.push(s);
        c.sessions.sort((a, b) => a.number - b.number);
        return s.id;
      },
    },
    'campaign/updateSession': {
      handler(ctx: ActionContext, { sessionId, patch }: SessionPayload = {}) {
        const c = camp(ctx);
        patchItem(ctx, 'sessions', find(ctx, 'sessions', sessionId), patch, ['number', 'title', 'date', 'plan', 'recap', 'played', 'doc']);
        c.sessions.sort((a, b) => a.number - b.number);
      },
    },
    'campaign/deleteSession': {
      handler(ctx: ActionContext, { sessionId }: SessionPayload = {}) {
        remove(ctx, 'sessions', sessionId);
      },
    },

    // ----- threads -----
    'campaign/addThread': {
      handler(ctx: ActionContext, payload: Raw = {}) {
        const t = normThread({ ...payload, label: str(payload.label) || ctx.t('New thread'), id: undefined }, ctx.uid);
        t.id = ctx.uid('th');
        camp(ctx).threads.push(t);
        return t.id;
      },
    },
    'campaign/updateThread': {
      handler(ctx: ActionContext, { threadId, patch }: ThreadPayload = {}) {
        patchItem(ctx, 'threads', find(ctx, 'threads', threadId), patch, ['label', 'state', 'notes']);
      },
    },
    'campaign/deleteThread': {
      handler(ctx: ActionContext, { threadId }: ThreadPayload = {}) {
        remove(ctx, 'threads', threadId);
      },
    },
    'campaign/moveThread': {
      handler(ctx: ActionContext, { threadId, dir }: ThreadPayload = {}) {
        move(ctx, 'threads', threadId, dir);
      },
    },

    // ----- handouts -----
    'campaign/addHandout': {
      handler(ctx: ActionContext, payload: Raw = {}) {
        const h = normHandout({ ...payload, title: str(payload.title) || ctx.t('New handout'), id: undefined, revealedTo: [], revealedAt: undefined }, ctx.uid, ctx.now);
        h.id = ctx.uid('ho');
        camp(ctx).handouts.push(h);
        return h.id;
      },
    },
    'campaign/updateHandout': {
      handler(ctx: ActionContext, { handoutId, patch }: HandoutPayload = {}) {
        patchItem(ctx, 'handouts', find(ctx, 'handouts', handoutId), patch, ['title', 'body', 'image', 'gmNotes']);
      },
    },
    'campaign/deleteHandout': {
      handler(ctx: ActionContext, { handoutId }: HandoutPayload = {}) {
        remove(ctx, 'handouts', handoutId);
      },
    },
    // to: 'all' | [userId]. Notifies only the players who did not have it yet.
    'campaign/revealHandout': {
      handler(ctx: ActionContext, { handoutId, to }: HandoutPayload = {}) {
        const h = find(ctx, 'handouts', handoutId);
        const users = playerIds(ctx.state);
        const before = h.revealedTo === 'all' ? users : h.revealedTo;
        let recipients: UserId[];
        if (to === 'all') {
          recipients = users.filter((id) => !before.includes(id));
          const wasAll = h.revealedTo === 'all';
          h.revealedTo = 'all';
          if (wasAll) return { notified: [] };
        } else {
          const ids = idList(Array.isArray(to) ? to : [to]).filter((id) => users.includes(id));
          if (!ids.length) ctx.fail('Choose at least one player');
          if (h.revealedTo === 'all') return { notified: [] };
          const revealed = h.revealedTo;
          recipients = ids.filter((id) => !revealed.includes(id));
          h.revealedTo = [...h.revealedTo, ...recipients];
        }
        h.revealedAt = ctx.now;
        const i18n = { key: 'New handout: {title}', params: { title: h.title } };
        if (to === 'all') {
          ctx.log({ kind: 'system', author: 'MJ', i18n });
          ctx.emitTo('players', 'sfx', { id: 'notify' });
          emitHandout(ctx, 'players', { id: h.id, title: h.title });
        } else if (recipients.length) {
          ctx.log({ kind: 'system', author: 'MJ', i18n, to: [...recipients, 'gm'] });
          ctx.emitTo(recipients, 'sfx', { id: 'notify' });
          emitHandout(ctx, recipients, { id: h.id, title: h.title });
        }
        return { notified: recipients };
      },
    },
    // userId given: hide from that player only; otherwise hide from everyone.
    'campaign/hideHandout': {
      handler(ctx: ActionContext, { handoutId, userId }: HandoutPayload = {}) {
        const h = find(ctx, 'handouts', handoutId);
        if (!userId) {
          h.revealedTo = [];
          return;
        }
        const base = h.revealedTo === 'all' ? playerIds(ctx.state) : h.revealedTo;
        h.revealedTo = base.filter((id) => id !== userId);
      },
    },

    // ----- texts -----
    'campaign/updateNotes': {
      handler(ctx: ActionContext, { text }: TextPayload = {}) {
        camp(ctx).notes = md(text);
      },
    },
    'campaign/updatePlayerRecap': {
      handler(ctx: ActionContext, { text }: TextPayload = {}) {
        camp(ctx).playerRecap = md(text);
      },
    },
  },

  filter(view, user) {
    const c = (view.campaign || {}) as Partial<Campaign>;
    const handouts = (c.handouts || [])
      .filter((h) => h.revealedTo === 'all' || (Array.isArray(h.revealedTo) && h.revealedTo.includes(user.id)))
      .map((h) => ({ id: h.id, title: h.title, body: h.body, image: h.image || '', ts: h.ts, revealedAt: h.revealedAt || h.ts, toAll: h.revealedTo === 'all' }));
    view.campaign = { handouts, playerRecap: c.playerRecap || '' } satisfies PlayerCampaignView;
  },
};

function pick(obj: Raw, keys: string[]): Raw {
  const out: Raw = {};
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  return out;
}

export default mod;
