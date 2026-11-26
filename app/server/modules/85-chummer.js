// Chummer5a interoperability: import a .chum5 into a new actor, re-import (update) an existing actor with a
// confirmation diff, export an actor to a .chum5 that Chummer5a 5.226 opens. Players may export their own sheet
// and upload it back (directly, or as a pending request the GM approves — see state.chummer.allowPlayerImport).
// Library code lives in server/lib/chummer/ (xml.js, data.js, parse.js, export.js, merge.js).
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { currentUploadDir, currentUploadUrl, localFileForUrl } from '../store.js';
import { uid, deepClone } from '../../shared/util.js';
import { normalizeActor, slugify } from '../../client/modules/sheet/sheet-data.js';
import { parseChum5, sha1, ChummerError } from '../lib/chummer/parse.js';
import { exportChum5, detachMugshots } from '../lib/chummer/export.js';
import { mergeActor, diffActors } from '../lib/chummer/merge.js';
import { errorBody, formatFr } from '../lib/i18n.js';
import { errorParam } from '../lib/chummer/messages.js';

const tk = (s) => s; // marks French keys used as values (tools/i18n-check.js)
/** HTTP error body for an error that may carry an i18n key (Chummer/XML errors). */
const errBody = (err, fallback) => (err?.i18nKey ? errorBody(err.i18nKey, err.i18nParams) : err?.message ? { error: err.message } : errorBody(fallback));

const MAX_PENDING = 20;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

function slice(state) {
  state.chummer = isObj(state.chummer) ? state.chummer : {};
  const s = state.chummer;
  if (typeof s.allowPlayerImport !== 'boolean') s.allowPlayerImport = true;
  if (!Array.isArray(s.pending)) s.pending = [];
  return s;
}

/** Public part of actor.chummer (never the XML). */
export function chummerSummary(c) {
  if (!isObj(c)) return undefined;
  const { xml, ...rest } = c;
  return { ...rest, hasFile: !!xml };
}

/** Strip the stored .chum5 XML from a view (players, and the GM once the core calls it — see report). */
export function stripChummer(view) {
  for (const a of Object.values(view.actors || {})) if (a && a.chummer) a.chummer = chummerSummary(a.chummer);
  for (const r of view.chummer?.pending || []) delete r.xml;
}

function owns(user, actorId) {
  return user.role === 'gm' || (user.characterIds || []).includes(actorId);
}

function cleanFileName(s) {
  return String(s || '').replace(/[\\/]+/g, '_').replace(/[^\p{L}\p{N} ._()\-]+/gu, '').trim().slice(0, 120);
}

function bodyText(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  // application/json bodies are already parsed by the core's express.json()
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) return JSON.stringify(req.body);
  return '';
}

/** Save a Chummer mugshot (base64) to the uploads dir; returns its URL or null. */
function saveMugshot(b64) {
  if (!b64 || b64.length > 15e6) return null;
  try {
    const buf = Buffer.from(String(b64).replace(/\s+/g, ''), 'base64');
    let ext = null;
    if (buf[0] === 0x89 && buf[1] === 0x50) ext = 'png';
    else if (buf[0] === 0xff && buf[1] === 0xd8) ext = 'jpg';
    else if (buf.slice(0, 3).toString() === 'GIF') ext = 'gif';
    else if (buf.slice(8, 12).toString() === 'WEBP') ext = 'webp';
    if (!ext) return null;
    const file = `chummer-${sha1(buf).slice(0, 12)}.${ext}`;
    const dir = currentUploadDir(); // uploads of the current table
    const full = path.join(dir, file);
    if (!fs.existsSync(full)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(full, buf);
    }
    return `${currentUploadUrl()}/${file}`;
  } catch {
    return null;
  }
}

/** Base64 images to embed in an exported file: the stored Chummer portraits, else the app portrait. */
function mugshotsFor(actor) {
  const urls = actor.chummer?.mugshots?.length ? actor.chummer.mugshots : actor.portrait ? [actor.portrait] : [];
  const out = [];
  for (const u of urls) {
    // Local images only (uploads or imported assets), in formats Chummer (.NET System.Drawing) can read.
    if (!/\.(png|jpe?g|gif|bmp)$/i.test(String(u || '').split(/[?#]/)[0])) continue;
    const file = localFileForUrl(u); // /uploads, /assets or this table's /t/<slug>/… (null for anything else)
    if (!file) continue;
    try {
      const buf = fs.readFileSync(file);
      if (buf.length < 8e6) out.push(buf.toString('base64'));
    } catch {}
  }
  return out;
}

/** Parse + merge an uploaded file against an existing actor (no state change). `mugshots`: already detached images. */
function prepareUpdate(actor, rawXml, fileName, now, mugshots = null) {
  const det = mugshots ? { xml: rawXml, urls: mugshots, mainIndex: 0 } : detachMugshots(String(rawXml).replace(/^﻿/, ''), saveMugshot);
  const parsed = parseChum5(det.xml, { fileName, now });
  let base = null;
  if (actor.chummer?.xml) {
    try {
      base = parseChum5(actor.chummer.xml, { keepXml: false, makeId: () => 'base' }).actor;
    } catch {
      base = null;
    }
  }
  const merged = mergeActor(actor, parsed.actor, base, { now, fileName });
  if (det.urls.length) {
    merged.chummer.mugshots = det.urls;
    if (!merged.portrait) merged.portrait = det.urls[det.mainIndex] || det.urls[0];
  }
  normalizeActor(merged, uid);
  return { merged, diff: diffActors(actor, merged), warnings: parsed.warnings, warningsI18n: parsed.warningsI18n, info: parsed.info, linked: !!base, xml: det.xml, mugshots: det.urls };
}

/** Short summary of a diff as translatable parts [{ t, params }] (a list param: joined with ', '). */
function summaryParts(diff) {
  const parts = [];
  for (const s of diff.scalars) if (['Karma', 'Nuyens'].includes(s.label)) parts.push({ t: '{label} {from} → {to}', params: { label: { t: s.label }, from: s.from, to: s.to } });
  if (diff.attributes.length) parts.push({ t: '{n} attribut(s)', params: { n: diff.attributes.length } });
  if (diff.skills.length) parts.push({ t: '{n} compétence(s)', params: { n: diff.skills.length } });
  const items = diff.lists.reduce((n, l) => n + l.added.length + l.removed.length + l.changed.length, 0);
  if (items) parts.push({ t: '{n} élément(s) d’inventaire', params: { n: items } });
  return parts.length ? parts : [{ t: 'aucun changement' }];
}
/** French text of the summary (stored in pending requests, as before). */
const summaryText = (parts) => formatFr('{list}', { list: parts });

function applyUpdate(state, actorId, merged, { by, fileName, diff, addLog }) {
  merged.id = actorId;
  state.actors[actorId] = merged;
  const params = { actor: merged.name, file: fileName, user: by, summary: summaryParts(diff) };
  const key = fileName
    ? by ? tk('{actor} mis à jour depuis Chummer ({file}) par {user} : {summary}.') : tk('{actor} mis à jour depuis Chummer ({file}) : {summary}.')
    : by ? tk('{actor} mis à jour depuis Chummer par {user} : {summary}.') : tk('{actor} mis à jour depuis Chummer : {summary}.');
  addLog({ kind: 'system', author: 'Chummer', i18n: { key, params }, gmOnly: true });
}

export default {
  name: 'chummer',

  init(state) {
    slice(state);
    // Drop requests whose actor disappeared.
    state.chummer.pending = state.chummer.pending.filter((r) => r && state.actors?.[r.actorId]);
  },

  actions: {
    // GM: { allowPlayerImport: bool }
    'chummer/settings': {
      role: 'gm',
      handler(ctx, { allowPlayerImport }) {
        const s = slice(ctx.state);
        if (typeof allowPlayerImport !== 'boolean') ctx.fail('Réglage invalide');
        s.allowPlayerImport = allowPlayerImport;
        return s.allowPlayerImport;
      },
    },

    // GM: { requestId, approve: bool, note? } → applies (re-merged against the current actor) or denies a player's upload.
    'chummer/resolve': {
      role: 'gm',
      handler(ctx, { requestId, approve, note }) {
        const s = slice(ctx.state);
        const r = s.pending.find((x) => x.id === requestId);
        if (!r) ctx.fail('Demande introuvable');
        if (r.status !== 'pending') ctx.fail('Demande déjà traitée');
        const actor = ctx.state.actors[r.actorId];
        if (!actor) ctx.fail('Personnage introuvable');
        if (approve) {
          let prep;
          try {
            prep = prepareUpdate(actor, r.xml, r.fileName, ctx.now, r.mugshots || []);
          } catch (err) {
            ctx.fail(err.i18nKey || err.message || tk('Fichier illisible'), err.i18nParams);
          }
          applyUpdate(ctx.state, r.actorId, prep.merged, { by: r.userName, fileName: r.fileName, diff: prep.diff, addLog: ctx.log });
          ctx.emitTo(r.userId, 'sfx', { id: 'notify' });
        }
        r.status = approve ? 'approved' : 'denied';
        r.resolvedAt = ctx.now;
        if (note) r.gmNote = String(note).slice(0, 300);
        delete r.xml;
        // Keep only pending requests + the 10 most recent resolved ones.
        const resolved = s.pending.filter((x) => x.status !== 'pending').sort((a, b) => b.resolvedAt - a.resolvedAt).slice(0, 10);
        s.pending = s.pending.filter((x) => x.status === 'pending' || resolved.includes(x));
        return r.status;
      },
    },

    // Player (own request) or GM: { requestId }
    'chummer/cancel': {
      role: 'any',
      handler(ctx, { requestId }) {
        const s = slice(ctx.state);
        const r = s.pending.find((x) => x.id === requestId);
        if (!r) ctx.fail('Demande introuvable');
        if (!ctx.isGM && r.userId !== ctx.user.id) ctx.fail('Ce n’est pas ta demande');
        s.pending = s.pending.filter((x) => x !== r);
        return true;
      },
    },

    // GM: { actorId } → forget the stored Chummer file (next export generates a fresh file).
    'chummer/unlink': {
      role: 'gm',
      handler(ctx, { actorId }) {
        const a = ctx.state.actors[actorId];
        if (!a) ctx.fail('Personnage introuvable');
        if (!a.chummer) ctx.fail('Ce personnage n’est lié à aucun fichier Chummer');
        delete a.chummer;
        for (const list of Object.values(a)) if (Array.isArray(list)) for (const it of list) if (isObj(it)) delete it.chummerGuid;
        if (a.lifestyle) delete a.lifestyle.chummerGuid;
        return true;
      },
    },
  },

  filter(view, user) {
    const s = view.chummer || {};
    view.chummer = {
      allowPlayerImport: s.allowPlayerImport !== false,
      pending: (s.pending || []).filter((r) => r.userId === user.id),
    };
    stripChummer(view);
  },

  /** Not called by the core yet (GM views are not filtered): see the Chummer report. */
  gmFilter(view) {
    stripChummer(view);
  },

  routes(app, { requireGM, requireUser, getState, scheduleBroadcast, emitTo, addLog, saveSoon }) {
    const textBody = express.text({ type: () => true, limit: '20mb' });
    const done = () => {
      saveSoon();
      scheduleBroadcast();
    };
    // Answer once the (30 ms debounced) state broadcast has gone out, so the client already has the new actor
    // when it opens the sheet.
    const replyAfterBroadcast = (res, payload) => setTimeout(() => res.json(payload), 60);

    /** New actor from a .chum5 (or an exported Actor JSON). GM only. */
    function importNew(req, res) {
      const state = getState();
      const raw = bodyText(req);
      const fileName = cleanFileName(req.query.fileName || req.headers['x-filename'] || '');
      let actor;
      let warnings = [];
      let warningsI18n = [];
      if (/^\s*[{[]/.test(raw)) {
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return res.status(400).json(errorBody('JSON invalide'));
        }
        const src = isObj(body?.actor) ? body.actor : body;
        if (!isObj(src) || !src.name || !isObj(src.attributes)) return res.status(400).json(errorBody('Ce JSON ne ressemble pas à une fiche de personnage (name + attributes attendus)'));
        actor = deepClone(src);
        actor.type = actor.type === 'npc' ? 'npc' : 'pc';
        delete actor.training;
      } else if (raw.includes('<character')) {
        const det = detachMugshots(raw.replace(/^﻿/, ''), saveMugshot);
        const parsed = parseChum5(det.xml, { fileName, now: Date.now() });
        actor = parsed.actor;
        warnings = parsed.warnings;
        warningsI18n = parsed.warningsI18n;
        if (det.urls.length) {
          actor.chummer.mugshots = det.urls;
          actor.portrait = det.urls[det.mainIndex] || det.urls[0];
        }
      } else {
        return res.status(400).json(errorBody('Fichier non reconnu : envoie un .chum5 (Chummer5) ou un export JSON de fiche'));
      }
      const type = req.query.type === 'npc' ? 'npc' : req.query.type === 'pc' ? 'pc' : actor.type;
      actor.type = type;
      const id = actor.id && !state.actors[actor.id] && /^[\w-]{1,60}$/.test(actor.id) ? actor.id : uid(type);
      actor.id = id;
      if (type === 'npc') actor.color ||= '#e05c5c';
      normalizeActor(actor, uid);
      state.actors[id] = actor;
      addLog({ kind: 'system', author: 'MJ', i18n: { key: actor.chummer ? tk('Fiche importée : {actor} (Chummer).') : tk('Fiche importée : {actor}.'), params: { actor: actor.name } }, gmOnly: true });
      done();
      replyAfterBroadcast(res, { actorId: id, warnings, warningsI18n });
    }

    function targetActor(req, res) {
      const state = getState();
      const actorId = String(req.query.actorId || '');
      const actor = state.actors[actorId];
      if (!actor) {
        res.status(404).json(errorBody('Personnage introuvable'));
        return null;
      }
      if (!owns(req.user, actorId)) {
        res.status(403).json(errorBody('Ce personnage ne t’appartient pas'));
        return null;
      }
      return actor;
    }

    function checkChum5(raw, res) {
      if (!raw.includes('<character')) {
        res.status(400).json(errorBody('Ce fichier n’est pas une fiche Chummer5 (.chum5)'));
        return false;
      }
      return true;
    }

    /** Re-import into an existing actor (apply, or pending request for players when not allowed). */
    function update(req, res) {
      const state = getState();
      const s = slice(state);
      const actor = targetActor(req, res);
      if (!actor) return;
      const raw = bodyText(req);
      if (!checkChum5(raw, res)) return;
      const fileName = cleanFileName(req.query.fileName || req.headers['x-filename'] || '');
      const prep = prepareUpdate(actor, raw, fileName, Date.now());
      const gm = req.user.role === 'gm';
      if (gm || s.allowPlayerImport) {
        applyUpdate(state, actor.id, prep.merged, { by: gm ? null : req.user.name, fileName, diff: prep.diff, addLog });
        done();
        return replyAfterBroadcast(res, { applied: true, actorId: actor.id, diff: prep.diff, warnings: prep.warnings, warningsI18n: prep.warningsI18n });
      }
      // Player without permission: one pending request per actor & user (the newest replaces the older one).
      s.pending = s.pending.filter((r) => !(r.status === 'pending' && r.actorId === actor.id && r.userId === req.user.id));
      const request = {
        id: uid('chq'), ts: Date.now(), actorId: actor.id, actorName: actor.name, userId: req.user.id, userName: req.user.name,
        fileName, xml: prep.xml, mugshots: prep.mugshots, diff: prep.diff, summary: '', summaryI18n: summaryParts(prep.diff), warnings: prep.warnings, warningsI18n: prep.warningsI18n, status: 'pending',
      };
      request.summary = summaryText(request.summaryI18n);
      s.pending.push(request);
      while (s.pending.length > MAX_PENDING) s.pending.splice(s.pending.findIndex((r) => r.status !== 'pending') >= 0 ? s.pending.findIndex((r) => r.status !== 'pending') : 0, 1);
      addLog({ kind: 'system', author: 'Chummer', i18n: { key: '{user} demande à mettre à jour {actor} depuis Chummer ({summary}).', params: { user: req.user.name, actor: actor.name, summary: request.summaryI18n } }, gmOnly: true });
      emitTo('gm', 'sfx', { id: 'notify' });
      done();
      replyAfterBroadcast(res, { applied: false, pending: true, requestId: request.id, diff: prep.diff, warnings: prep.warnings, warningsI18n: prep.warningsI18n });
    }

    const wrap = (fn) => (req, res) => {
      try {
        fn(req, res);
      } catch (err) {
        if (!(err instanceof ChummerError)) console.error('[chummer]', err);
        if (!res.headersSent) res.status(400).json(errBody(err, tk('Opération Chummer impossible')));
      }
    };

    // POST /api/chummer/import[?type=pc|npc][&fileName=] — GM: new actor. Player: ?actorId= → same as update.
    app.post('/api/chummer/import', requireUser, textBody, wrap((req, res) => {
      if (req.query.actorId) return update(req, res);
      if (req.user.role !== 'gm') return res.status(403).json(errorBody('Seul le MJ peut créer un personnage depuis un fichier'));
      importNew(req, res);
    }));
    // Legacy URL (characters module used to own it): GM import of a .chum5 or Actor JSON.
    app.post('/api/actors/import-chum5', requireGM, textBody, wrap(importNew));

    // POST /api/chummer/preview?actorId= — diff of a re-import, nothing applied.
    app.post('/api/chummer/preview', requireUser, textBody, wrap((req, res) => {
      const actor = targetActor(req, res);
      if (!actor) return;
      const raw = bodyText(req);
      if (!checkChum5(raw, res)) return;
      const fileName = cleanFileName(req.query.fileName || req.headers['x-filename'] || '');
      const prep = prepareUpdate(actor, raw, fileName, Date.now());
      const s = slice(getState());
      res.json({
        actorId: actor.id, fileName, diff: prep.diff, warnings: prep.warnings, warningsI18n: prep.warningsI18n, linked: prep.linked, created: prep.info.created,
        needsApproval: req.user.role !== 'gm' && !s.allowPlayerImport,
      });
    }));

    // POST /api/chummer/update?actorId= — apply a re-import (or create a pending request).
    app.post('/api/chummer/update', requireUser, textBody, wrap(update));

    // GET /api/chummer/export/:actorId — owner or GM → attachment "<name>.chum5"
    app.get('/api/chummer/export/:actorId', requireUser, wrap((req, res) => {
      const state = getState();
      const actor = state.actors[req.params.actorId];
      if (!actor || !actor.attributes) return res.status(404).json(errorBody('Personnage introuvable'));
      if (!owns(req.user, actor.id)) return res.status(403).json(errorBody('Ce personnage ne t’appartient pas'));
      const now = Date.now();
      const result = exportChum5(actor, { now, mugshots: mugshotsFor(actor) });
      const stored = detachMugshots(result.xml, saveMugshot);
      // Remember the guids given to new items and keep the exported file as the new sync base, so the
      // file the player edits in Chummer can be merged back precisely.
      for (const [list, map] of Object.entries(result.assigned)) {
        if (list === 'lifestyle') {
          if (actor.lifestyle) actor.lifestyle.chummerGuid = map.guid;
          continue;
        }
        for (const it of actor[list] || []) if (map[it.id]) it.chummerGuid = map[it.id];
      }
      const fileBase = (actor.name || 'personnage').replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '_').trim() || 'personnage';
      actor.chummer = {
        ...(actor.chummer || {}), xml: stored.xml, ...(stored.urls.length ? { mugshots: stored.urls } : {}), fileName: actor.chummer?.fileName || `${fileBase}.chum5`, exportedAt: now, syncedAt: now,
        sourceHash: sha1(result.xml), created: /<created>True<\/created>/.test(result.xml), appVersion: actor.chummer?.appVersion || '5.226.0',
      };
      done();
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${slugify(fileBase)}.chum5"; filename*=UTF-8''${encodeURIComponent(fileBase)}.chum5`);
      res.setHeader('X-Chummer-Mode', result.mode);
      res.setHeader('X-Chummer-Warnings', encodeURIComponent(JSON.stringify(result.warnings.slice(0, 30))));
      res.setHeader('X-Chummer-Warnings-I18n', encodeURIComponent(JSON.stringify((result.warningsI18n || []).slice(0, 30))));
      res.setHeader('Access-Control-Expose-Headers', 'X-Chummer-Mode, X-Chummer-Warnings, X-Chummer-Warnings-I18n, Content-Disposition');
      res.send(Buffer.from('﻿' + result.xml, 'utf8'));
    }));
  },
};
