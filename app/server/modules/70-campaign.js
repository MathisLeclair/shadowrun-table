// Campaign module: acts, quests, sessions, narrative threads, handouts, GM notes, player recap.
// Seeds: data/seed/campaign.json, then every data/seed/campaign/*.json (sorted, later files override
// fields of the same id). Seed items are only added when missing; an item the GM never touched is
// refreshed when its seed changes (tracked with hashes in campaign._seed), GM edits are never overwritten.
import fs from 'node:fs';
import path from 'node:path';

export const QUEST_STATUS = ['upcoming', 'active', 'done', 'skipped'];
export const THREAD_STATES = ['open', 'dormant', 'resolved', 'dead'];
const COLLECTIONS = ['acts', 'quests', 'sessions', 'threads', 'handouts'];
const TEXTS = ['playerRecap', 'notes'];

const MAX_TITLE = 200;
const MAX_MD = 200000;
const MAX_IDS = 60;

// ---------------------------------------------------------------------------
// Sanitizers (used for seeds and for every payload coming from the client)
// ---------------------------------------------------------------------------
const str = (v, max = MAX_TITLE) => (v === undefined || v === null ? '' : String(v)).slice(0, max);
const md = (v) => str(v, MAX_MD);
const cleanId = (v) => str(v, 80).trim().replace(/[^\w.\-:]/g, '_');
const idList = (v) => (Array.isArray(v) ? [...new Set(v.map(cleanId).filter(Boolean))].slice(0, MAX_IDS) : []);
/** 'file.md' or 'file.md#Heading' — basename only. */
function docRef(v) {
  const s = str(v, 300).trim();
  if (!s) return '';
  const [file, ...frag] = s.split('#');
  const base = path.basename(file.trim());
  if (!base.toLowerCase().endsWith('.md')) return '';
  return frag.length ? `${base}#${frag.join('#').trim().slice(0, 200)}` : base;
}
function imageUrl(v) {
  const s = str(v, 500).trim();
  if (!s) return '';
  return /^(\/(uploads|assets)\/|https?:\/\/)/.test(s) && !/["'<>\s]/.test(s) ? s : '';
}

function normAct(a = {}, uid) {
  return { id: cleanId(a.id) || uid('act'), title: str(a.title) || 'Nouvel acte', summary: md(a.summary) };
}
function normPhase(p = {}, uid) {
  return { id: cleanId(p.id) || uid('ph'), title: str(p.title) || 'Nouvelle phase', text: md(p.text), done: !!p.done };
}
function normQuest(q = {}, uid) {
  // Phases without id get a deterministic one (p1, p2…) so seeds hash identically at every boot.
  const phases = Array.isArray(q.phases)
    ? q.phases.slice(0, 50).filter((p) => p && typeof p === 'object').map((p, i) => normPhase({ ...p, id: cleanId(p.id) || `p${i + 1}` }, uid))
    : [];
  // Phase ids must be unique within a quest.
  const seen = new Set();
  for (const p of phases) {
    if (seen.has(p.id)) p.id = uid('ph');
    seen.add(p.id);
  }
  return {
    id: cleanId(q.id) || uid('q'),
    actId: cleanId(q.actId),
    title: str(q.title) || 'Nouvelle quête',
    status: QUEST_STATUS.includes(q.status) ? q.status : 'upcoming',
    summary: md(q.summary),
    phases,
    npcs: idList(q.npcs),
    maps: idList(q.maps),
    rewards: md(q.rewards),
    gmNotes: md(q.gmNotes),
    doc: docRef(q.doc),
  };
}
function normSession(s = {}, uid) {
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
function normThread(t = {}, uid) {
  return {
    id: cleanId(t.id) || uid('th'),
    label: str(t.label) || 'Nouveau fil',
    state: THREAD_STATES.includes(t.state) ? t.state : 'open',
    notes: md(t.notes),
  };
}
function revealList(v) {
  if (v === 'all') return 'all';
  return idList(v);
}
function normHandout(h = {}, uid, now = Date.now()) {
  const out = {
    id: cleanId(h.id) || uid('ho'),
    title: str(h.title) || 'Nouveau document',
    body: md(h.body),
    image: imageUrl(h.image),
    revealedTo: revealList(h.revealedTo),
    ts: Number(h.ts) || now,
    gmNotes: md(h.gmNotes),
  };
  if (Number(h.revealedAt)) out.revealedAt = Number(h.revealedAt);
  return out;
}
const NORMALIZERS = { acts: normAct, quests: normQuest, sessions: normSession, threads: normThread, handouts: normHandout };

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------
function hash(v) {
  const s = JSON.stringify(v ?? null);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[campaign] seed ignored (${path.basename(file)}): ${err.message}`);
    return null;
  }
}

/** Read campaign.json then campaign/*.json (sorted). */
export function readCampaignSeeds(seedDir) {
  const out = [];
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
export function mergeSeeds(seeds) {
  const merged = { acts: [], quests: [], sessions: [], threads: [], handouts: [] };
  for (const seed of seeds) {
    if (!seed || typeof seed !== 'object') continue;
    for (const key of COLLECTIONS) {
      if (!Array.isArray(seed[key])) continue;
      for (const item of seed[key]) {
        if (!item || typeof item !== 'object' || !item.id) continue;
        const i = merged[key].findIndex((x) => x.id === item.id);
        if (i >= 0) merged[key][i] = { ...merged[key][i], ...item };
        else merged[key].push({ ...item });
      }
    }
    for (const key of TEXTS) if (typeof seed[key] === 'string') merged[key] = seed[key];
  }
  return merged;
}

/** Apply a merged seed to the campaign slice: add missing, refresh untouched, never overwrite GM edits. */
export function applySeed(campaign, seed, uid) {
  const meta = (campaign._seed = campaign._seed && typeof campaign._seed === 'object' ? campaign._seed : {});
  meta.hashes = meta.hashes || {};
  meta.deleted = Array.isArray(meta.deleted) ? meta.deleted : [];
  const seedTs = Date.UTC(2080, 0, 1);
  for (const key of COLLECTIONS) {
    const list = campaign[key];
    for (const raw of seed[key] || []) {
      const item = key === 'handouts' ? normHandout(raw, uid, seedTs) : NORMALIZERS[key](raw, uid);
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
    if (typeof seed[key] !== 'string') continue;
    const hk = `text:${key}`;
    const h = hash(seed[key]);
    if (typeof campaign[key] !== 'string' || (campaign[key] === '' && !meta.hashes[hk])) {
      campaign[key] = md(seed[key]);
      meta.hashes[hk] = h;
    } else if (meta.hashes[hk] && meta.hashes[hk] !== h && hash(campaign[key]) === meta.hashes[hk]) {
      campaign[key] = md(seed[key]);
      meta.hashes[hk] = h;
    }
  }
  return campaign;
}

function ensureSlice(state, uid) {
  const c = (state.campaign = state.campaign && typeof state.campaign === 'object' ? state.campaign : {});
  for (const key of COLLECTIONS) {
    c[key] = Array.isArray(c[key]) ? c[key].filter((x) => x && typeof x === 'object' && x.id) : [];
    if (key === 'handouts') c[key] = c[key].map((h) => normHandout(h, uid));
    else c[key] = c[key].map((x) => NORMALIZERS[key](x, uid));
  }
  for (const key of TEXTS) if (typeof c[key] !== 'string') c[key] = undefined;
  if (c.currentActId !== undefined && typeof c.currentActId !== 'string') c.currentActId = null;
  return c;
}

let fallbackCounter = 0;
const localUid = (p) => `${p}_${Date.now().toString(36)}${(fallbackCounter++).toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

// ---------------------------------------------------------------------------
// Helpers for actions
// ---------------------------------------------------------------------------
function camp(ctx) {
  if (!ctx.state.campaign) ensureSlice(ctx.state, ctx.uid);
  return ctx.state.campaign;
}
function find(ctx, key, id, label) {
  const item = camp(ctx)[key].find((x) => x.id === id);
  if (!item) ctx.fail(`${label} introuvable`);
  return item;
}
function remove(ctx, key, id, label) {
  const c = camp(ctx);
  const i = c[key].findIndex((x) => x.id === id);
  if (i < 0) ctx.fail(`${label} introuvable`);
  const [item] = c[key].splice(i, 1);
  const hk = `${key}:${id}`;
  // A deleted seed item must not come back at the next boot.
  if (c._seed?.hashes?.[hk] && !c._seed.deleted.includes(hk)) c._seed.deleted.push(hk);
  return item;
}
function move(ctx, key, id, dir, label) {
  const list = camp(ctx)[key];
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) ctx.fail(`${label} introuvable`);
  const j = i + (Number(dir) < 0 ? -1 : 1);
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}
/** Apply a whitelisted patch through the normalizer (keeps id). */
function patchItem(ctx, key, item, patch, allowed) {
  if (!patch || typeof patch !== 'object') ctx.fail('Modification invalide');
  const next = { ...item };
  for (const k of allowed) if (Object.prototype.hasOwnProperty.call(patch, k)) next[k] = patch[k];
  // Invalid enum values are ignored rather than reset to the default.
  if (key === 'quests' && !QUEST_STATUS.includes(next.status)) next.status = item.status;
  if (key === 'threads' && !THREAD_STATES.includes(next.state)) next.state = item.state;
  const norm = NORMALIZERS[key](next, ctx.uid);
  norm.id = item.id;
  if (key === 'handouts' && item.revealedAt) norm.revealedAt = item.revealedAt;
  Object.assign(item, norm);
  return item;
}
const playerIds = (state) => Object.keys(state.users || {});

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------
export default {
  name: 'campaign',

  init(state, { seedDir } = {}) {
    const c = ensureSlice(state, localUid);
    let seeds = [];
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
      handler(ctx, { title, summary } = {}) {
        const act = normAct({ title, summary }, ctx.uid);
        act.id = ctx.uid('act');
        camp(ctx).acts.push(act);
        return act.id;
      },
    },
    'campaign/updateAct': {
      handler(ctx, { actId, patch } = {}) {
        patchItem(ctx, 'acts', find(ctx, 'acts', actId, 'Acte'), patch, ['title', 'summary']);
      },
    },
    'campaign/deleteAct': {
      handler(ctx, { actId } = {}) {
        const c = camp(ctx);
        if (c.quests.some((q) => q.actId === actId)) ctx.fail('Cet acte contient encore des quêtes');
        remove(ctx, 'acts', actId, 'Acte');
        if (c.currentActId === actId) c.currentActId = null;
      },
    },
    // null = automatic (act of the first active quest)
    'campaign/setCurrentAct': {
      handler(ctx, { actId } = {}) {
        if (actId) find(ctx, 'acts', actId, 'Acte');
        camp(ctx).currentActId = actId || null;
      },
    },

    // ----- quests -----
    'campaign/addQuest': {
      handler(ctx, payload = {}) {
        const c = camp(ctx);
        const q = normQuest({ ...payload, id: undefined }, ctx.uid);
        q.id = ctx.uid('q');
        if (!q.actId || !c.acts.some((a) => a.id === q.actId)) q.actId = c.acts[0]?.id || '';
        c.quests.push(q);
        return q.id;
      },
    },
    'campaign/updateQuest': {
      handler(ctx, { questId, patch } = {}) {
        const q = find(ctx, 'quests', questId, 'Quête');
        patchItem(ctx, 'quests', q, patch, ['actId', 'title', 'status', 'summary', 'phases', 'npcs', 'maps', 'rewards', 'gmNotes', 'doc']);
      },
    },
    'campaign/deleteQuest': {
      handler(ctx, { questId } = {}) {
        remove(ctx, 'quests', questId, 'Quête');
      },
    },
    'campaign/moveQuest': {
      handler(ctx, { questId, dir } = {}) {
        // Move within the same act: swap with the previous/next quest of that act.
        const list = camp(ctx).quests;
        const q = find(ctx, 'quests', questId, 'Quête');
        const same = list.filter((x) => x.actId === q.actId);
        const k = same.indexOf(q) + (Number(dir) < 0 ? -1 : 1);
        if (k < 0 || k >= same.length) return;
        const i = list.indexOf(q);
        const j = list.indexOf(same[k]);
        [list[i], list[j]] = [list[j], list[i]];
      },
    },
    'campaign/setQuestStatus': {
      handler(ctx, { questId, status } = {}) {
        if (!QUEST_STATUS.includes(status)) ctx.fail('Statut invalide');
        find(ctx, 'quests', questId, 'Quête').status = status;
      },
    },
    'campaign/togglePhase': {
      handler(ctx, { questId, phaseId, done } = {}) {
        const q = find(ctx, 'quests', questId, 'Quête');
        const p = q.phases.find((x) => x.id === phaseId);
        if (!p) ctx.fail('Phase introuvable');
        p.done = typeof done === 'boolean' ? done : !p.done;
        if (p.done && q.status === 'upcoming') q.status = 'active';
        return p.done;
      },
    },
    'campaign/addPhase': {
      handler(ctx, { questId, title, text } = {}) {
        const q = find(ctx, 'quests', questId, 'Quête');
        if (q.phases.length >= 50) ctx.fail('Trop de phases');
        const p = normPhase({ title, text }, ctx.uid);
        p.id = ctx.uid('ph');
        q.phases.push(p);
        return p.id;
      },
    },
    'campaign/updatePhase': {
      handler(ctx, { questId, phaseId, patch } = {}) {
        const q = find(ctx, 'quests', questId, 'Quête');
        const p = q.phases.find((x) => x.id === phaseId);
        if (!p) ctx.fail('Phase introuvable');
        if (!patch || typeof patch !== 'object') ctx.fail('Modification invalide');
        const next = normPhase({ ...p, ...pick(patch, ['title', 'text', 'done']) }, ctx.uid);
        Object.assign(p, next, { id: p.id });
      },
    },
    'campaign/deletePhase': {
      handler(ctx, { questId, phaseId } = {}) {
        const q = find(ctx, 'quests', questId, 'Quête');
        const before = q.phases.length;
        q.phases = q.phases.filter((p) => p.id !== phaseId);
        if (q.phases.length === before) ctx.fail('Phase introuvable');
      },
    },
    'campaign/movePhase': {
      handler(ctx, { questId, phaseId, dir } = {}) {
        const q = find(ctx, 'quests', questId, 'Quête');
        const i = q.phases.findIndex((p) => p.id === phaseId);
        if (i < 0) ctx.fail('Phase introuvable');
        const j = i + (Number(dir) < 0 ? -1 : 1);
        if (j < 0 || j >= q.phases.length) return;
        [q.phases[i], q.phases[j]] = [q.phases[j], q.phases[i]];
      },
    },

    // ----- sessions -----
    'campaign/addSession': {
      handler(ctx, payload = {}) {
        const c = camp(ctx);
        const next = c.sessions.reduce((m, s) => Math.max(m, s.number || 0), 0) + 1;
        const s = normSession({ number: next, title: `Séance ${next}`, ...payload, id: undefined, played: false }, ctx.uid);
        s.id = ctx.uid('ses');
        c.sessions.push(s);
        c.sessions.sort((a, b) => a.number - b.number);
        return s.id;
      },
    },
    'campaign/updateSession': {
      handler(ctx, { sessionId, patch } = {}) {
        const c = camp(ctx);
        patchItem(ctx, 'sessions', find(ctx, 'sessions', sessionId, 'Séance'), patch, ['number', 'title', 'date', 'plan', 'recap', 'played', 'doc']);
        c.sessions.sort((a, b) => a.number - b.number);
      },
    },
    'campaign/deleteSession': {
      handler(ctx, { sessionId } = {}) {
        remove(ctx, 'sessions', sessionId, 'Séance');
      },
    },

    // ----- threads -----
    'campaign/addThread': {
      handler(ctx, payload = {}) {
        const t = normThread({ ...payload, id: undefined }, ctx.uid);
        t.id = ctx.uid('th');
        camp(ctx).threads.push(t);
        return t.id;
      },
    },
    'campaign/updateThread': {
      handler(ctx, { threadId, patch } = {}) {
        patchItem(ctx, 'threads', find(ctx, 'threads', threadId, 'Fil narratif'), patch, ['label', 'state', 'notes']);
      },
    },
    'campaign/deleteThread': {
      handler(ctx, { threadId } = {}) {
        remove(ctx, 'threads', threadId, 'Fil narratif');
      },
    },
    'campaign/moveThread': {
      handler(ctx, { threadId, dir } = {}) {
        move(ctx, 'threads', threadId, dir, 'Fil narratif');
      },
    },

    // ----- handouts -----
    'campaign/addHandout': {
      handler(ctx, payload = {}) {
        const h = normHandout({ ...payload, id: undefined, revealedTo: [], revealedAt: undefined }, ctx.uid, ctx.now);
        h.id = ctx.uid('ho');
        camp(ctx).handouts.push(h);
        return h.id;
      },
    },
    'campaign/updateHandout': {
      handler(ctx, { handoutId, patch } = {}) {
        patchItem(ctx, 'handouts', find(ctx, 'handouts', handoutId, 'Document'), patch, ['title', 'body', 'image', 'gmNotes']);
      },
    },
    'campaign/deleteHandout': {
      handler(ctx, { handoutId } = {}) {
        remove(ctx, 'handouts', handoutId, 'Document');
      },
    },
    // to: 'all' | [userId]. Notifies only the players who did not have it yet.
    'campaign/revealHandout': {
      handler(ctx, { handoutId, to } = {}) {
        const h = find(ctx, 'handouts', handoutId, 'Document');
        const users = playerIds(ctx.state);
        const before = h.revealedTo === 'all' ? users : h.revealedTo;
        let recipients;
        if (to === 'all') {
          recipients = users.filter((id) => !before.includes(id));
          const wasAll = h.revealedTo === 'all';
          h.revealedTo = 'all';
          if (wasAll) return { notified: [] };
        } else {
          const ids = idList(Array.isArray(to) ? to : [to]).filter((id) => users.includes(id));
          if (!ids.length) ctx.fail('Choisis au moins un joueur');
          if (h.revealedTo === 'all') return { notified: [] };
          recipients = ids.filter((id) => !h.revealedTo.includes(id));
          h.revealedTo = [...h.revealedTo, ...recipients];
        }
        h.revealedAt = ctx.now;
        const text = `Nouveau document : ${h.title}`;
        if (to === 'all') {
          ctx.log({ kind: 'system', author: 'MJ', text });
          ctx.emitTo('players', 'sfx', { id: 'notify' });
          ctx.emitTo('players', 'campaign/handout', { id: h.id, title: h.title });
        } else if (recipients.length) {
          ctx.log({ kind: 'system', author: 'MJ', text, to: [...recipients, 'gm'] });
          ctx.emitTo(recipients, 'sfx', { id: 'notify' });
          ctx.emitTo(recipients, 'campaign/handout', { id: h.id, title: h.title });
        }
        return { notified: recipients };
      },
    },
    // userId given: hide from that player only; otherwise hide from everyone.
    'campaign/hideHandout': {
      handler(ctx, { handoutId, userId } = {}) {
        const h = find(ctx, 'handouts', handoutId, 'Document');
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
      handler(ctx, { text } = {}) {
        camp(ctx).notes = md(text);
      },
    },
    'campaign/updatePlayerRecap': {
      handler(ctx, { text } = {}) {
        camp(ctx).playerRecap = md(text);
      },
    },
  },

  filter(view, user) {
    const c = view.campaign || {};
    const handouts = (c.handouts || [])
      .filter((h) => h.revealedTo === 'all' || (Array.isArray(h.revealedTo) && h.revealedTo.includes(user.id)))
      .map((h) => ({ id: h.id, title: h.title, body: h.body, image: h.image || '', ts: h.ts, revealedAt: h.revealedAt || h.ts, toAll: h.revealedTo === 'all' }));
    view.campaign = { handouts, playerRecap: c.playerRecap || '' };
  },
};

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  return out;
}
