// Training module: karma advancement requests, GM approval, downtime training jobs (SR5 p.103-107).
// Rules live in shared/advancement.js. See ARCHITECTURE.md « Training ».
//
// state.training = { settings, requests: [Request], daysElapsed }
// Request = { id, ts, actorId, userId, kind, target, from, to, label, karmaCost, nuyenCost, days, daysBase,
//             instructor, ppCost, status: 'pending'|'approved'|'denied'|'done'|'cancelled', note?, gmNote?,
//             manual?: bool (not verified against the catalog → always needs GM approval), request: normalized request,
//             resolvedTs?, doneTs?, jobId? }
// actor.training = [{ id, requestId, kind, label, labelI18n, daysTotal, daysDone, startedTs, request }]
// label = French text, labelI18n = { key, params } (same text, translated by the client: t(key, params)).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncPowerBonus } from '../lib/augment.js';
import {
  DEFAULT_SETTINGS, quote, applyAdvance, normalizeRequest, catalogName, qualityInfo, powerInfo, spellInfo, formatDaysI18n,
} from '../../shared/advancement.js';
import { formatFr } from '../lib/i18n.js';

/** Marks a translatable log/history key for tools/i18n-check.js (English in client/i18n/en/training.json). */
const tk = (s) => s;

const CATALOG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'catalog');
const MAX_REQUESTS = 400;
const OPEN = ['pending', 'approved'];

// --- catalog (read from disk, cached by mtime) ------------------------------------------------
const catalogCache = {};
function loadCatalog(name) {
  const file = path.join(CATALOG_DIR, `${name}.json`);
  try {
    const st = fs.statSync(file);
    if (catalogCache[name]?.mtime === st.mtimeMs) return catalogCache[name].items;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
    catalogCache[name] = { mtime: st.mtimeMs, items };
    return items;
  } catch {
    return [];
  }
}
function findCatalog(name, id) {
  if (!id) return null;
  return loadCatalog(name).find((i) => i && i.id === id) || null;
}

/** Keep a player-provided precision « Nom (précision) » when it extends the catalog name. */
function keepExtra(given, catalogNameStr) {
  const m = String(given || '').match(/\(([^)]{1,40})\)\s*$/);
  return m && !catalogNameStr.includes('(') ? `${catalogNameStr} (${m[1].trim()})` : catalogNameStr;
}

/** Replace client-provided data with authoritative catalog data. Returns true if verified. */
function enrichFromCatalog(req) {
  switch (req.kind) {
    case 'quality': {
      const item = findCatalog('qualities', req.catalogId);
      if (!item) return false;
      const qi = qualityInfo(item);
      req.name = keepExtra(req.name, catalogName(item));
      req.altName = String(item.name || '').slice(0, 80);
      req.karma = qi.karma;
      req.positive = qi.positive;
      return true;
    }
    case 'spell': {
      const item = findCatalog('spells', req.catalogId);
      if (!item) return false;
      req.name = keepExtra(req.name, catalogName(item));
      req.altName = String(item.name || '').slice(0, 80);
      req.data = spellInfo(item);
      return true;
    }
    case 'power': {
      const item = findCatalog('powers', req.catalogId);
      if (!item) return false;
      const pi = powerInfo(item);
      req.name = keepExtra(req.name, catalogName(item));
      req.altName = String(item.name || '').slice(0, 80);
      req.pp = pi.pp;
      req.levels = pi.levels;
      req.maxLevel = pi.maxLevel;
      req.extraPP = pi.extraPP;
      return true;
    }
    case 'complexForm': {
      const item = findCatalog('complexforms', req.catalogId);
      if (item) req.name = catalogName(item);
      return true; // fixed cost, nothing to cheat on
    }
    case 'other':
      return false;
    default:
      return true; // computed purely from rules
  }
}

// --- helpers -----------------------------------------------------------------------------------
function slice(state) {
  const tr = (state.training = state.training && typeof state.training === 'object' ? state.training : {});
  const s = (tr.settings = { ...DEFAULT_SETTINGS, ...(tr.settings || {}) });
  s.instructorCostPerWeek = { ...DEFAULT_SETTINGS.instructorCostPerWeek, ...(s.instructorCostPerWeek || {}) };
  if (!Array.isArray(tr.requests)) tr.requests = [];
  if (typeof tr.daysElapsed !== 'number') tr.daysElapsed = 0;
  return tr;
}

function ownersOf(state, actorId) {
  return Object.values(state.users || {})
    .filter((u) => (u.characterIds || []).includes(actorId))
    .map((u) => u.id);
}
/** Log entry visible to the actor's owners and the GM only. */
function privateLog(ctx, actorId, key, params) {
  return ctx.log({ kind: 'training', userId: ctx.user.id, author: 'Progression', i18n: { key, params }, to: [...new Set([...ownersOf(ctx.state, actorId), 'gm'])] });
}
function publicLog(ctx, key, params) {
  return ctx.log({ kind: 'training', userId: ctx.user.id, author: 'Progression', i18n: { key, params } });
}
/** Label of a request/job as a log/error param: translatable when the i18n form is known. */
const labelParam = (x) => (x?.labelI18n?.key ? { t: x.labelI18n.key, ...(x.labelI18n.params ? { params: x.labelI18n.params } : {}) } : x?.label || '');
/** Fail with the rule message of a quote (French text + i18n key). */
function failQuote(ctx, q) {
  if (q.errorI18n) ctx.fail(q.errorI18n.key, q.errorI18n.params);
  ctx.fail(q.error);
}

function jobsOf(actor) {
  return Array.isArray(actor.training) ? actor.training : [];
}

/** Other open requests/jobs of an actor (for conflicts) and karma/nuyen engaged by pending ones. */
function contextFor(tr, actor, exceptId) {
  const pending = tr.requests.filter((r) => r.actorId === actor.id && r.status === 'pending' && r.id !== exceptId);
  const jobs = jobsOf(actor).filter((j) => j.requestId !== exceptId);
  return {
    active: [...pending, ...jobs],
    reservedKarma: pending.reduce((s, r) => s + (Number(r.karmaCost) || 0), 0),
    reservedNuyen: pending.reduce((s, r) => s + (Number(r.nuyenCost) || 0), 0),
  };
}

function trimRequests(tr) {
  if (tr.requests.length <= MAX_REQUESTS) return;
  let excess = tr.requests.length - MAX_REQUESTS;
  tr.requests = tr.requests.filter((r) => {
    if (excess > 0 && !OPEN.includes(r.status)) {
      excess--;
      return false;
    }
    return true;
  });
}

/** History entry: { text (French), i18n: { key, params } } + karma/nuyen deltas. */
function pushHistory(actor, key, params, extra) {
  actor.history = Array.isArray(actor.history) ? actor.history : [];
  actor.history.push({ ts: Date.now(), text: formatFr(key, params), i18n: { key, params }, ...extra });
}

function charge(actor, request) {
  const k = Number(request.karmaCost) || 0;
  const n = Number(request.nuyenCost) || 0;
  actor.karma = (Number(actor.karma) || 0) - k;
  if (n) actor.nuyen = (Number(actor.nuyen) || 0) - n;
  if (k || n) {
    const extra = {};
    if (k) extra.karma = -k;
    if (n) extra.nuyen = -n;
    if (n) pushHistory(actor, tk('Progression : {label} (instructeur)'), { label: labelParam(request) }, extra);
    else pushHistory(actor, tk('Progression : {label}'), { label: labelParam(request) }, extra);
  }
}

function findPowerFor(actor, req) {
  const list = Array.isArray(actor.powers) ? actor.powers : [];
  const n = (s) => String(s || '').trim().toLowerCase();
  return (req.target && list.find((p) => p.id === req.target)) || list.find((p) => (req.catalogId && p.catalogId === req.catalogId) || n(p.name) === n(req.name)) || null;
}

/** applyAdvance + the catalog bonus of adept powers (Improved Reflexes: REA and initiative dice per level). */
function advance(actor, req) {
  const before = req?.kind === 'power' ? findPowerFor(actor, req) : null;
  const fromLevel = before ? Math.max(1, Number(before.level) || 1) : 0;
  const summary = applyAdvance(actor, req);
  if (req?.kind === 'power' && req.catalogId) {
    const bonus = findCatalog('powers', req.catalogId)?.stats?.bonus;
    const p = findPowerFor(actor, req);
    if (bonus && p) syncPowerBonus(actor, p, bonus, fromLevel);
  }
  return summary;
}

function completeJob(ctx, actor, job, { forced = false } = {}) {
  const tr = slice(ctx.state);
  const summary = advance(actor, job.request);
  actor.training = jobsOf(actor).filter((j) => j.id !== job.id);
  const req = tr.requests.find((r) => r.id === job.requestId);
  if (req) {
    req.status = 'done';
    req.doneTs = Date.now();
  }
  const p = { actor: actor.name, label: labelParam(job) };
  if (forced) publicLog(ctx, tk('▲ {actor} a terminé : {label} (validé par le MJ)'), p);
  else publicLog(ctx, tk('▲ {actor} a terminé : {label}'), p);
  ctx.emitTo([...ownersOf(ctx.state, actor.id), 'gm'], 'sfx', { id: 'level-up' });
  return { actorId: actor.id, actorName: actor.name, label: job.label, labelI18n: job.labelI18n, summary };
}

/** Approve: charge karma/nuyen, then apply now or start a downtime job. */
function approve(ctx, request, gmNote) {
  const tr = slice(ctx.state);
  const actor = ctx.state.actors[request.actorId];
  if (!actor) ctx.fail('Personnage introuvable');
  const q = quote(actor, request.request, tr.settings, contextFor(tr, actor, request.id));
  if (q.error) failQuote(ctx, q);
  Object.assign(request, {
    from: q.from, to: q.to, label: q.label, labelI18n: q.labelI18n, karmaCost: q.karmaCost, nuyenCost: q.nuyenCost, days: q.days, daysBase: q.daysBase,
    instructor: q.instructor, ppCost: q.ppCost, request: q.req, status: 'approved', resolvedTs: Date.now(),
  });
  if (gmNote) request.gmNote = gmNote;
  charge(actor, request);
  if (q.days <= 0) {
    advance(actor, q.req);
    request.status = 'done';
    request.doneTs = Date.now();
    publicLog(ctx, tk('▲ {actor} progresse : {label}'), { actor: actor.name, label: labelParam(q) });
    ctx.emitTo([...ownersOf(ctx.state, actor.id), 'gm'], 'sfx', { id: 'level-up' });
    return request;
  }
  const job = { id: ctx.uid('job'), requestId: request.id, kind: q.kind, label: q.label, labelI18n: q.labelI18n, daysTotal: q.days, daysDone: 0, startedTs: Date.now(), request: q.req };
  actor.training = [...jobsOf(actor), job];
  request.jobId = job.id;
  const p = { actor: actor.name, label: labelParam(q), days: formatDaysI18n(q.days) };
  if (q.instructor) privateLog(ctx, actor.id, tk('{actor} commence l’entraînement : {label} — {days} avec instructeur'), p);
  else privateLog(ctx, actor.id, tk('{actor} commence l’entraînement : {label} — {days}'), p);
  return request;
}

function findRequest(ctx, id) {
  const r = slice(ctx.state).requests.find((x) => x.id === id);
  if (!r) ctx.fail('Demande introuvable');
  return r;
}

const clampInt = (v, lo, hi, d) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};

// --- module ------------------------------------------------------------------------------------
export default {
  name: 'training',

  init(state) {
    slice(state);
    // Test fixtures only (tools/test-training.js): inject actors when the env var is set.
    if (process.env.SR_TEST_TRAINING_ACTORS) {
      try {
        state.actors = state.actors || {};
        for (const a of JSON.parse(process.env.SR_TEST_TRAINING_ACTORS)) if (a?.id && !state.actors[a.id]) state.actors[a.id] = a;
      } catch (err) {
        console.error('[training] bad SR_TEST_TRAINING_ACTORS', err);
      }
    }
  },

  actions: {
    // payload: { actorId, kind, target, to, name?, spec?, attr?, ktype?, karma?, pp?, levels?, catalogId?, data?, options?,
    //            instructor?, note?, days? (other), free? (GM) }
    'training/request': {
      role: 'any',
      handler(ctx, payload = {}) {
        const tr = slice(ctx.state);
        const actor = ctx.state.actors?.[payload.actorId];
        if (!actor) ctx.fail('Personnage introuvable');
        if (!ctx.owns(actor.id)) ctx.fail('Ce personnage ne t’appartient pas');
        if (!ctx.isGM && actor.retired) ctx.fail('Ce personnage est à la retraite');
        const req = normalizeRequest(payload);
        if (!ctx.isGM) req.free = false;
        const verified = enrichFromCatalog(req);
        const q = quote(actor, req, tr.settings, contextFor(tr, actor));
        if (q.error) failQuote(ctx, q);
        const manual = !verified || q.manual;
        const request = {
          id: ctx.uid('trq'), ts: Date.now(), actorId: actor.id, userId: ctx.user.id, kind: q.kind, target: q.target,
          from: q.from, to: q.to, label: q.label, labelI18n: q.labelI18n, karmaCost: q.karmaCost, nuyenCost: q.nuyenCost, days: q.days, daysBase: q.daysBase,
          instructor: q.instructor, ppCost: q.ppCost, status: 'pending', manual, request: q.req,
        };
        if (req.note) request.note = req.note;
        tr.requests.push(request);
        trimRequests(tr);
        const auto = ctx.isGM || (tr.settings.approval === 'never' && !manual);
        if (auto) {
          try {
            approve(ctx, request);
          } catch (err) {
            tr.requests = tr.requests.filter((r) => r.id !== request.id);
            throw err;
          }
        } else {
          const p = { actor: actor.name, label: labelParam(q), karma: q.karmaCost, nuyen: q.nuyenCost };
          if (q.nuyenCost && manual) privateLog(ctx, actor.id, tk('{actor} demande : {label} — {karma} karma, {nuyen}¥ (saisie manuelle)'), p);
          else if (q.nuyenCost) privateLog(ctx, actor.id, tk('{actor} demande : {label} — {karma} karma, {nuyen}¥'), p);
          else if (manual) privateLog(ctx, actor.id, tk('{actor} demande : {label} — {karma} karma (saisie manuelle)'), p);
          else privateLog(ctx, actor.id, tk('{actor} demande : {label} — {karma} karma'), p);
          ctx.emitTo('gm', 'sfx', { id: 'notify' });
        }
        return { requestId: request.id, status: request.status };
      },
    },

    // GM. payload: { requestId, approve: bool, note? }
    'training/resolve': {
      role: 'gm',
      handler(ctx, { requestId, approve: ok, note } = {}) {
        const request = findRequest(ctx, requestId);
        if (request.status !== 'pending') ctx.fail('Cette demande a déjà été traitée');
        const gmNote = String(note || '').trim().slice(0, 300);
        if (ok) {
          approve(ctx, request, gmNote);
        } else {
          request.status = 'denied';
          request.resolvedTs = Date.now();
          if (gmNote) request.gmNote = gmNote;
          const actor = ctx.state.actors[request.actorId];
          const p = { actor: actor?.name || '?', label: labelParam(request), note: gmNote };
          if (gmNote) privateLog(ctx, request.actorId, tk('Demande refusée pour {actor} : {label} — « {note} »'), p);
          else privateLog(ctx, request.actorId, tk('Demande refusée pour {actor} : {label}'), p);
        }
        return { status: request.status };
      },
    },

    // Owner: cancel own pending request. GM: also stop an approved (in-progress) training;
    // refund (default true) gives back karma and instructor nuyens. Finished trainings cannot be cancelled.
    // payload: { requestId, refund? }
    'training/cancel': {
      role: 'any',
      handler(ctx, { requestId, refund = true } = {}) {
        const request = findRequest(ctx, requestId);
        if (!ctx.owns(request.actorId)) ctx.fail('Cette demande ne t’appartient pas');
        const actor = ctx.state.actors[request.actorId];
        if (request.status === 'pending') {
          request.status = 'cancelled';
          request.resolvedTs = Date.now();
          return { status: request.status };
        }
        if (request.status !== 'approved') ctx.fail('Cette demande est déjà close');
        if (!ctx.isGM) ctx.fail('Entraînement en cours : seul le MJ peut l’interrompre');
        if (actor) {
          actor.training = jobsOf(actor).filter((j) => j.requestId !== request.id);
          if (refund) {
            const k = Number(request.karmaCost) || 0;
            const n = Number(request.nuyenCost) || 0;
            actor.karma = (Number(actor.karma) || 0) + k;
            if (n) actor.nuyen = (Number(actor.nuyen) || 0) + n;
            if (k || n) {
              const extra = {};
              if (k) extra.karma = k;
              if (n) extra.nuyen = n;
              pushHistory(actor, tk('Remboursement : {label} (entraînement interrompu)'), { label: labelParam(request) }, extra);
            }
          }
          const p = { actor: actor.name, label: labelParam(request) };
          if (refund) privateLog(ctx, request.actorId, tk('Entraînement interrompu pour {actor} : {label} (remboursé)'), p);
          else privateLog(ctx, request.actorId, tk('Entraînement interrompu pour {actor} : {label}'), p);
        }
        request.status = 'cancelled';
        request.resolvedTs = Date.now();
        return { status: request.status, refunded: !!refund };
      },
    },

    // GM: downtime. payload: { days, actorIds? } → { days, completed: [{ actorId, actorName, label }], progressed }
    'training/advanceDays': {
      role: 'gm',
      handler(ctx, { days, actorIds } = {}) {
        const tr = slice(ctx.state);
        const d = clampInt(days, 1, 3650, 0);
        if (!d) ctx.fail('Nombre de jours invalide');
        const only = Array.isArray(actorIds) && actorIds.length ? new Set(actorIds) : null;
        const completed = [];
        let progressed = 0;
        for (const actor of Object.values(ctx.state.actors || {})) {
          if (only && !only.has(actor.id)) continue;
          for (const job of [...jobsOf(actor)]) {
            job.daysDone = Math.min(job.daysTotal, (Number(job.daysDone) || 0) + d);
            progressed++;
            if (job.daysDone >= job.daysTotal) completed.push(completeJob(ctx, actor, job));
          }
        }
        if (!only) tr.daysElapsed += d;
        const p = { days: formatDaysI18n(d), n: completed.length };
        if (!completed.length) publicLog(ctx, tk('⏱ Temps mort : {days}.'), p);
        else if (completed.length === 1) publicLog(ctx, tk('un::⏱ Temps mort : {days}. {n} entraînement(s) terminé(s).'), p);
        else publicLog(ctx, tk('⏱ Temps mort : {days}. {n} entraînement(s) terminé(s).'), p);
        return { days: d, completed, progressed };
      },
    },

    // GM: finish a job now. payload: { actorId, jobId }
    'training/complete': {
      role: 'gm',
      handler(ctx, { actorId, jobId } = {}) {
        const actor = ctx.state.actors?.[actorId];
        if (!actor) ctx.fail('Personnage introuvable');
        const job = jobsOf(actor).find((j) => j.id === jobId);
        if (!job) ctx.fail('Entraînement introuvable');
        return completeJob(ctx, actor, job, { forced: true });
      },
    },

    // GM. payload: { approval?, useTime?, instructorTimeReduction?, instructorCostPerWeek?: { attribute, skill, knowledge, other } }
    'training/updateSettings': {
      role: 'gm',
      handler(ctx, patch = {}) {
        const s = slice(ctx.state).settings;
        if (patch.approval === 'always' || patch.approval === 'never') s.approval = patch.approval;
        if (typeof patch.useTime === 'boolean') s.useTime = patch.useTime;
        if (patch.instructorTimeReduction !== undefined) s.instructorTimeReduction = clampInt(patch.instructorTimeReduction, 0, 90, s.instructorTimeReduction);
        if (patch.instructorCostPerWeek && typeof patch.instructorCostPerWeek === 'object') {
          for (const k of ['attribute', 'skill', 'knowledge', 'other']) {
            if (patch.instructorCostPerWeek[k] !== undefined) s.instructorCostPerWeek[k] = clampInt(patch.instructorCostPerWeek[k], 0, 1e6, s.instructorCostPerWeek[k]);
          }
        }
        return s;
      },
    },

    // GM: remove closed requests (done/denied/cancelled), optionally for one actor. payload: { actorId? }
    'training/clearHistory': {
      role: 'gm',
      handler(ctx, { actorId } = {}) {
        const tr = slice(ctx.state);
        const before = tr.requests.length;
        tr.requests = tr.requests.filter((r) => OPEN.includes(r.status) || (actorId && r.actorId !== actorId));
        return { removed: before - tr.requests.length };
      },
    },
  },

  // Players only see requests concerning their own characters.
  filter(view, user) {
    if (!view.training) return;
    const mine = new Set(user.characterIds || []);
    view.training.requests = (view.training.requests || []).filter((r) => mine.has(r.actorId));
  },
};
