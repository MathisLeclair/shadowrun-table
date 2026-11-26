// Characters module: PC + NPC actors, sheets, damage/healing, Edge, karma/nuyen rewards, dice rolls.
// State slice: state.actors (see ARCHITECTURE.md "Actors").
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { derive, attr, skillPool, rollDice, SKILL_BY_ID, ATTR_LABELS, ATTR_SHORT, ATTRS, skillDefaultLimit } from '../../shared/sr5.js';
import { uid, deepClone, nuyen as fmtNuyen } from '../../shared/util.js';
import {
  ITEM_LISTS, PLAYER_ITEM_FIELDS, PLAYER_ACTOR_KEYS, MERGE_KEYS, normalizeActor, blankActor, healthStatus, categoryToSkill,
  evalFormula, slugify, METATYPE_FR, MELEE_SKILLS,
} from '../../client/modules/sheet/sheet-data.js';
import { applyBonus, removeBonus, weaponFromStats, wareCatalogItem, detachAugmentation } from '../lib/augment.js';
import { errorBody } from '../lib/i18n.js';

/** Marker for the i18n checker: French keys stored as data (history texts…), translated by the client. */
const tk = (s) => s;

const clampInt = (v, lo, hi, d = 0) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};
const str = (v, max = 4000) => (v === undefined || v === null ? '' : String(v).slice(0, max));
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function getActor(ctx, id) {
  const a = ctx.state.actors[id];
  if (!a) ctx.fail('Personnage introuvable');
  // Actors created by other modules (bestiary spawn…) may lack item ids / arrays: fix them lazily.
  normalizeActor(a, uid);
  return a;
}

function requireOwn(ctx, actorId) {
  if (!ctx.owns(actorId)) ctx.fail('Ce personnage ne t’appartient pas');
}

/** Keep condition boxes within the monitors (overflow may reach BOD + 1 = dead). */
function clampCondition(a) {
  const d = derive(a);
  const c = a.condition;
  c.physical = clampInt(c.physical, 0, d.physicalMonitor);
  c.stun = clampInt(c.stun, 0, d.stunMonitor);
  c.overflow = clampInt(c.overflow, 0, d.overflowMax + 1);
}

function statusOf(a) {
  const d = derive(a);
  return healthStatus(a.condition, d.physicalMonitor, d.stunMonitor, d.overflowMax);
}

function cleanColor(v) {
  const s = String(v || '');
  return /^#[0-9a-fA-F]{3,8}$/.test(s) ? s : null;
}

function cleanUrl(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^(\/uploads\/|\/assets\/|https?:\/\/)/.test(s)) return s.slice(0, 500);
  return null;
}

/** Sanitize a few well-known fields on any patch (GM or player). */
function sanitizeTop(key, value, actor, ctx) {
  switch (key) {
    case 'id':
      ctx.fail('L’identifiant ne peut pas être modifié');
      break;
    case 'name':
      if (!String(value || '').trim()) ctx.fail('Le nom ne peut pas être vide');
      return String(value).trim().slice(0, 80);
    case 'type':
      if (!['pc', 'npc'].includes(value)) ctx.fail('Type invalide (pc ou npc)');
      return value;
    case 'color': {
      const c = cleanColor(value);
      if (!c) ctx.fail('Couleur invalide (format #rrggbb)');
      return c;
    }
    case 'portrait': {
      const u = cleanUrl(value);
      if (u === null) ctx.fail('Adresse de portrait invalide');
      return u;
    }
    case 'notes':
    case 'bio':
    case 'gmNotes':
      return str(value, 50000);
    case 'concept':
    case 'player':
    case 'gender':
      return str(value, 200);
    case 'karma':
    case 'karmaTotal':
    case 'nuyen':
    case 'streetCred':
    case 'notoriety':
    case 'publicAwareness':
    case 'age':
      return clampInt(value, -1e9, 1e9);
    default:
      return value;
  }
}

function applyPatch(ctx, a, patch) {
  if (!isObj(patch)) ctx.fail('Modification invalide');
  if (!ctx.isGM) {
    const bad = Object.keys(patch).filter((k) => !PLAYER_ACTOR_KEYS.includes(k));
    if (bad.length) ctx.fail('Tu ne peux pas modifier ça toi-même ({fields}) — demande au MJ, à la boutique ou à l’entraînement.', { fields: bad.join(', ') });
  }
  for (const [k, v] of Object.entries(patch)) {
    if (BAD_KEYS.has(k)) continue;
    if (MERGE_KEYS.includes(k)) {
      if (v === null) {
        if (['condition', 'edge', 'attributes'].includes(k)) ctx.fail('Champ obligatoire');
        delete a[k];
        continue;
      }
      if (!isObj(v)) ctx.fail('Format invalide pour {field}', { field: k });
      if (!ctx.isGM && k === 'condition') {
        const allowed = ['physical', 'stun', 'overflow'];
        if (Object.keys(v).some((x) => !allowed.includes(x))) ctx.fail('Champ de condition inconnu');
      }
      if (!ctx.isGM && k === 'edge' && Object.keys(v).some((x) => x !== 'current')) ctx.fail('Seule la Chance actuelle peut être modifiée');
      a[k] = { ...(isObj(a[k]) ? a[k] : {}), ...v };
      if (k === 'condition') for (const x of ['physical', 'stun', 'overflow']) a.condition[x] = clampInt(a.condition[x], 0, 99);
      if (k === 'attributes') for (const [ak, av] of Object.entries(a.attributes)) if (av !== null && av !== undefined) a.attributes[ak] = ak === 'ESS' ? Math.round(Math.max(0, Math.min(6, Number(av) || 0)) * 1000) / 1000 : clampInt(av, 0, 20);
    } else {
      const val = sanitizeTop(k, v, a, ctx);
      if (val === undefined || val === null) delete a[k];
      else a[k] = val;
    }
  }
  normalizeActor(a, uid);
  clampCondition(a);
}

/** Remove an actor and everything pointing at it (tokens, combat entries, user assignments). */
function removeActor(state, id) {
  delete state.actors[id];
  for (const m of Object.values(state.maps || {})) {
    if (Array.isArray(m?.tokens)) m.tokens = m.tokens.filter((t) => t.actorId !== id);
  }
  const cb = state.combat;
  if (cb && Array.isArray(cb.entries)) {
    const len = cb.entries.length;
    cb.entries = cb.entries.filter((e) => e.actorId !== id);
    if (cb.entries.length !== len) {
      // currentId is the source of truth (combat module); turn is rebuilt from it (-1 = nobody current).
      if (!cb.entries.some((e) => e.id === cb.currentId)) cb.currentId = null;
      cb.turn = cb.entries.findIndex((e) => e.id === cb.currentId);
    }
  }
  for (const u of Object.values(state.users || {})) {
    if (Array.isArray(u.characterIds)) u.characterIds = u.characterIds.filter((x) => x !== id);
  }
}

/** Index of an item by id; `index` is a fallback for items that had no id when the client rendered them. */
function findItem(ctx, a, list, itemId, index) {
  if (!ITEM_LISTS.includes(list)) ctx.fail('Liste inconnue : {list}', { list: String(list) });
  if (!Array.isArray(a[list])) a[list] = [];
  let idx = itemId ? a[list].findIndex((i) => i.id === itemId) : -1;
  if (idx < 0 && !itemId && Number.isInteger(index) && a[list][index]) idx = index;
  if (idx < 0) ctx.fail('Élément introuvable');
  return idx;
}

function sanitizeItem(list, item) {
  const out = deepClone(item);
  delete out.__proto__;
  if (out.name !== undefined) out.name = String(out.name).slice(0, 120);
  if (out.notes !== undefined) out.notes = str(out.notes, 5000);
  for (const k of ['rating', 'qty', 'connection', 'loyalty', 'rc', 'reach', 'level', 'body', 'armor', 'pilot', 'sensor', 'seats', 'ammoLeft']) {
    if (out[k] !== undefined && out[k] !== null && out[k] !== '') {
      const n = Number(out[k]);
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  if (out.essence !== undefined) out.essence = Math.round(Math.max(0, Number(out.essence) || 0) * 1000) / 1000;
  if (out.pp !== undefined) out.pp = Math.max(0, Number(out.pp) || 0);
  if (out.karma !== undefined) out.karma = Number(out.karma) || 0;
  if (list === 'qualities' && out.positive === undefined) out.positive = (out.karma || 0) >= 0;
  if (list === 'armor') out.equipped = !!out.equipped;
  if (list === 'sins' && typeof out.licenses === 'string') out.licenses = out.licenses.split(',').map((s) => s.trim()).filter(Boolean);
  return out;
}

const LIMIT_LABEL = { physical: 'physique', mental: 'mentale', social: 'sociale', astral: 'astrale' };
/** Upper-case status shown in PC damage logs (French keys). */
const STATUS_UPPER = { 'hors de combat': tk('HORS DE COMBAT'), mort: tk('MORT') };

function sfx(ctx, id, target = 'all') {
  ctx.emitTo(target, 'sfx', { id });
}

/** 'A, B et C' as a translatable log param. */
function names(list) {
  if (list.length <= 1) return list.join('');
  return { t: '{list} et {last}', params: { list: list.slice(0, -1).join(', '), last: list[list.length - 1] } };
}

// Chummer5 import/export lives in server/modules/85-chummer.js (+ server/lib/chummer/).

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------
export default {
  name: 'characters',

  init(state, { seedDir }) {
    state.actors ||= {};
    const dir = path.join(seedDir, 'actors');
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
        let list;
        try {
          list = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        } catch (err) {
          console.error(`[characters] seed ${f} invalide :`, err.message);
          continue;
        }
        for (const a of Array.isArray(list) ? list : [list]) {
          if (a && a.id && !state.actors[a.id]) state.actors[a.id] = deepClone(a);
        }
      }
    }
    for (const [id, a] of Object.entries(state.actors)) {
      if (!a || typeof a !== 'object') {
        delete state.actors[id];
        continue;
      }
      a.id = id;
      normalizeActor(a, uid);
    }
  },

  actions: {
    // { type: 'pc'|'npc', name, ...fields } → id
    'actor/create': {
      role: 'gm',
      handler(ctx, payload) {
        const { type = 'npc', name, ...rest } = payload || {};
        const cleanName = String(name || '').trim();
        if (!cleanName) ctx.fail('Donne un nom au personnage');
        const a = blankActor(type === 'pc' ? 'pc' : 'npc', cleanName.slice(0, 80));
        const id = ctx.uid(a.type);
        a.id = id;
        const { id: _ignore, ...fields } = rest;
        for (const [k, v] of Object.entries(fields)) {
          if (BAD_KEYS.has(k)) continue;
          if (MERGE_KEYS.includes(k) && isObj(v)) a[k] = { ...(a[k] || {}), ...v };
          else if (v !== undefined) a[k] = sanitizeTop(k, v, a, ctx);
        }
        normalizeActor(a, uid);
        if (fields.edge === undefined) a.edge.current = a.attributes.EDG;
        a.history.push({ ts: ctx.now, text: tk('Création du personnage') });
        ctx.state.actors[id] = a;
        return id;
      },
    },

    // { actorId, patch }
    'actor/update': {
      role: 'any',
      handler(ctx, { actorId, patch }) {
        const a = getActor(ctx, actorId);
        requireOwn(ctx, actorId);
        applyPatch(ctx, a, patch);
        return true;
      },
    },

    // { actorId } or { actorIds: [] }
    'actor/delete': {
      role: 'gm',
      handler(ctx, { actorId, actorIds }) {
        const ids = Array.isArray(actorIds) ? actorIds : [actorId];
        let n = 0;
        for (const id of ids) {
          if (id && ctx.state.actors[id]) {
            removeActor(ctx.state, id);
            n++;
          }
        }
        if (!n) ctx.fail('Personnage introuvable');
        return n;
      },
    },

    // { actorId, name? } → new id
    'actor/duplicate': {
      role: 'gm',
      handler(ctx, { actorId, name }) {
        const src = getActor(ctx, actorId);
        const a = deepClone(src);
        a.id = ctx.uid(a.type);
        a.name = String(name || ctx.t(tk('{name} (copie)'), { name: src.name })).slice(0, 80); // stored in the table language
        for (const k of ITEM_LISTS) if (Array.isArray(a[k]) && k !== 'skills') for (const it of a[k]) it.id = ctx.uid('itm');
        a.history = [...(a.history || []), { ts: ctx.now, text: `Copie de ${src.name}`, i18n: { key: 'Copie de {name}', params: { name: src.name } } }];
        normalizeActor(a, uid);
        ctx.state.actors[a.id] = a;
        return a.id;
      },
    },

    // { actorId, list, item, adjustEssence? } → item id
    'actor/addItem': {
      role: 'gm',
      handler(ctx, { actorId, list, item, adjustEssence }) {
        const a = getActor(ctx, actorId);
        if (!ITEM_LISTS.includes(list)) ctx.fail('Liste inconnue : {list}', { list: String(list) });
        if (!isObj(item)) ctx.fail('Élément invalide');
        const it = sanitizeItem(list, item);
        if (!Array.isArray(a[list])) a[list] = [];
        if (list === 'skills') {
          it.id = it.id || slugify(it.name || '');
          if (!it.id || it.id === 'x') ctx.fail('Compétence sans nom');
          if (a.skills.some((s) => s.id === it.id)) ctx.fail('Cette compétence est déjà sur la fiche');
          const def = SKILL_BY_ID[it.id];
          it.name = it.name || def?.fr || it.id;
          it.attr = it.attr || def?.attr || 'AGI';
          it.rating = clampInt(it.rating ?? 1, 0, 13, 1);
          if (def?.group && !it.group) it.group = def.group;
        } else {
          it.id = ctx.uid('itm');
          if (!it.name && list !== 'skillGroups') it.name = 'Nouvel élément';
        }
        if (list === 'gear' && it.qty === undefined) it.qty = 1;
        if (list === 'augmentations') {
          // Bonuses come from the catalog only (never from the client), recorded on the item so removal reverses them.
          delete it.bonus;
          const st = wareCatalogItem(it.catalogId)?.stats || {};
          const applied = applyBonus(a, st.bonus, it.rating, 1);
          if (applied) it.bonus = applied;
          if (st.weapon) {
            if (!Array.isArray(a.weapons)) a.weapons = [];
            a.weapons.push(weaponFromStats(ctx, it.name, it.category, st.weapon, { augId: it.id }));
          }
        }
        if (list === 'weapons') delete it.augId;
        if (list === 'powers') delete it.bonus;
        a[list].push(it);
        if (adjustEssence && list === 'augmentations' && it.essence) {
          a.attributes.ESS = Math.max(0, Math.round((a.attributes.ESS - it.essence) * 1000) / 1000);
        }
        return it.id;
      },
    },

    // { actorId, list, itemId, patch }
    'actor/updateItem': {
      role: 'any',
      handler(ctx, { actorId, list, itemId, index, patch }) {
        const a = getActor(ctx, actorId);
        requireOwn(ctx, actorId);
        const idx = findItem(ctx, a, list, itemId, index);
        if (!isObj(patch)) ctx.fail('Modification invalide');
        if (!ctx.isGM) {
          const allowed = PLAYER_ITEM_FIELDS[list] || [];
          const bad = Object.keys(patch).filter((k) => !allowed.includes(k));
          if (bad.length) ctx.fail(allowed.length ? tk('Tu peux seulement modifier : {fields}') : tk('Seul le MJ peut modifier cet élément'), allowed.length ? { fields: allowed.join(', ') } : undefined);
        }
        const clean = sanitizeItem(list, patch);
        delete clean.id;
        if (list === 'skills' && clean.rating !== undefined) clean.rating = clampInt(clean.rating, 0, 13);
        if (list === 'gear' && clean.qty !== undefined) {
          clean.qty = clampInt(clean.qty, 0, 9999);
          // Players may record consumption, never create units (they could then sell them to the shop).
          const cur = Math.max(0, Number(a[list][idx].qty ?? 1) || 0);
          if (!ctx.isGM && clean.qty > cur) ctx.fail('Seul le MJ peut augmenter une quantité');
        }
        if (list === 'augmentations' || list === 'powers') delete clean.bonus;
        if (list === 'weapons') delete clean.augId;
        if (list === 'weapons' && clean.ammoLeft !== undefined) clean.ammoLeft = clampInt(clean.ammoLeft, 0, 999);
        a[list][idx] = { ...a[list][idx], ...clean };
        for (const [k, v] of Object.entries(a[list][idx])) if (v === null) delete a[list][idx][k];
        return true;
      },
    },

    // { actorId, list, itemId, adjustEssence? }
    'actor/removeItem': {
      role: 'gm',
      handler(ctx, { actorId, list, itemId, index, adjustEssence }) {
        const a = getActor(ctx, actorId);
        const idx = findItem(ctx, a, list, itemId, index);
        const [it] = a[list].splice(idx, 1);
        if (list === 'augmentations') detachAugmentation(a, it); // its attribute/initiative bonus and implant weapon
        if (list === 'powers') removeBonus(a, it.bonus); // e.g. Improved Reflexes bought through training
        if (adjustEssence && list === 'augmentations' && it.essence) {
          a.attributes.ESS = Math.min(6, Math.round((a.attributes.ESS + Number(it.essence)) * 1000) / 1000);
        }
        return true;
      },
    },

    // { actorId, amount, type: 'P'|'S' } → { condition, status }
    'actor/damage': {
      role: 'any',
      handler(ctx, { actorId, amount, type }) {
        const a = getActor(ctx, actorId);
        requireOwn(ctx, actorId);
        const n = clampInt(amount, 0, 100);
        if (!n) ctx.fail('Indique un nombre de cases de dommages');
        if (!['P', 'S'].includes(type)) ctx.fail('Type de dommages invalide (P ou S)');
        const d = derive(a);
        const c = a.condition;
        const wasStatus = statusOf(a);
        let toPhysical = 0;
        if (type === 'S') {
          c.stun += n;
          if (c.stun > d.stunMonitor) {
            toPhysical = c.stun - d.stunMonitor;
            c.stun = d.stunMonitor;
          }
        } else toPhysical = n;
        if (toPhysical) {
          c.physical += toPhysical;
          if (c.physical > d.physicalMonitor) {
            c.overflow += c.physical - d.physicalMonitor;
            c.physical = d.physicalMonitor;
          }
        }
        c.overflow = Math.min(c.overflow, d.overflowMax + 1);
        const status = statusOf(a);
        // Translatable log line (status values are stored French words, translated as nested keys).
        let i18n;
        if (a.type === 'npc') {
          const damage = { t: type === 'S' ? tk('{n} case(s) de dommages étourdissants') : tk('{n} case(s) de dommages physiques'), params: { n } };
          i18n = status !== wasStatus
            ? { key: tk('{name} encaisse {damage} — {status}.'), params: { name: a.name, damage, status: { t: status } } }
            : { key: tk('{name} encaisse {damage}.'), params: { name: a.name, damage } };
        } else {
          const damage = type === 'S'
            ? { t: n > 1 ? tk('{n} dommages étourdissants') : tk('{n} dommage étourdissant'), params: { n } }
            : { t: n > 1 ? tk('{n} dommages physiques') : tk('{n} dommage physique'), params: { n } };
          const trackParams = { p: c.physical, pm: d.physicalMonitor, s: c.stun, sm: d.stunMonitor, o: c.overflow, om: d.overflowMax };
          const track = { t: c.overflow ? tk('P {p}/{pm} · É {s}/{sm} · surplus {o}/{om}') : tk('P {p}/{pm} · É {s}/{sm}'), params: trackParams };
          i18n = status !== wasStatus && STATUS_UPPER[status]
            ? { key: tk('{name} subit {damage} ({track}) — {status}'), params: { name: a.name, damage, track, status: { t: STATUS_UPPER[status] } } }
            : { key: tk('{name} subit {damage} ({track})'), params: { name: a.name, damage, track } };
        }
        ctx.log({ kind: 'combat', userId: ctx.user.id, author: a.name, i18n, gmOnly: a.type === 'npc' && !!a.hidden ? true : undefined });
        if (status === 'mort' && wasStatus !== 'mort') sfx(ctx, 'death');
        return { condition: { ...c }, status };
      },
    },

    // { actorId, amount, type: 'P'|'S'|'all' }
    'actor/heal': {
      role: 'any',
      handler(ctx, { actorId, amount, type }) {
        const a = getActor(ctx, actorId);
        requireOwn(ctx, actorId);
        const c = a.condition;
        if (type === 'all') {
          c.physical = 0;
          c.stun = 0;
          c.overflow = 0;
        } else {
          let n = clampInt(amount, 0, 999);
          if (!n) ctx.fail('Indique un nombre de cases à soigner');
          if (type === 'S') c.stun = Math.max(0, c.stun - n);
          else if (type === 'P') {
            const fromOverflow = Math.min(c.overflow, n);
            c.overflow -= fromOverflow;
            n -= fromOverflow;
            c.physical = Math.max(0, c.physical - n);
          } else ctx.fail('Type de soin invalide');
        }
        sfx(ctx, 'heal', a.type === 'npc' ? 'gm' : 'all');
        return { condition: { ...c }, status: statusOf(a) };
      },
    },

    // { actorId | actorIds, karma?, nuyen?, reason }
    'actor/adjust': {
      role: 'gm',
      handler(ctx, { actorId, actorIds, karma, nuyen, reason }) {
        const ids = Array.isArray(actorIds) ? actorIds : actorId ? [actorId] : [];
        if (!ids.length) ctx.fail('Choisis au moins un personnage');
        const dk = clampInt(karma, -10000, 10000);
        const dn = clampInt(nuyen, -1e8, 1e8);
        if (!dk && !dn) ctx.fail('Rien à ajuster (karma et nuyens à 0)');
        const typed = str(reason, 300).trim();
        const why = typed || (dk > 0 || dn > 0 ? tk('Récompense') : tk('Ajustement MJ'));
        const actors = ids.map((id) => getActor(ctx, id));
        for (const a of actors) {
          if (a.karma + dk < 0) ctx.fail('{name} n’a pas assez de karma ({karma})', { name: a.name, karma: a.karma });
          if (a.nuyen + dn < 0) ctx.fail('{name} n’a pas assez de nuyens ({nuyen})', { name: a.name, nuyen: fmtNuyen(a.nuyen) });
        }
        for (const a of actors) {
          a.karma += dk;
          if (dk > 0) a.karmaTotal += dk;
          a.nuyen += dn;
          a.history.push({ ts: ctx.now, text: why, ...(dk ? { karma: dk } : {}), ...(dn ? { nuyen: dn } : {}) });
        }
        const parts = [];
        if (dk) parts.push({ t: '{v} karma', params: { v: `${dk > 0 ? '+' : ''}${dk}` } });
        if (dn) parts.push(`${dn > 0 ? '+' : '−'}${fmtNuyen(Math.abs(dn))}`);
        const pcs = actors.filter((a) => !(a.type === 'npc' && a.hidden));
        ctx.log({
          kind: 'system', author: 'MJ', gmOnly: pcs.length ? undefined : true,
          i18n: { key: '{reason} : {changes} pour {names}.', params: { reason: typed || { t: why }, changes: parts, names: names(actors.map((a) => a.name)) } },
        });
        if (dk > 0) sfx(ctx, 'level-up');
        else if (dn > 0) sfx(ctx, 'cash');
        return true;
      },
    },

    // { actorId } → remaining Edge
    'edge/spend': {
      role: 'any',
      handler(ctx, { actorId, reason }) {
        const a = getActor(ctx, actorId);
        requireOwn(ctx, actorId);
        if (a.edge.current <= 0) ctx.fail('{name} n’a plus de point de Chance', { name: a.name });
        a.edge.current -= 1;
        const edgeParams = { name: a.name, cur: a.edge.current, max: a.attributes.EDG };
        const i18n = reason
          ? { key: tk('{name} dépense 1 point de Chance ({reason}) — reste {cur}/{max}.'), params: { ...edgeParams, reason: str(reason, 120) } }
          : { key: tk('{name} dépense 1 point de Chance — reste {cur}/{max}.'), params: edgeParams };
        ctx.log({ kind: 'system', userId: ctx.user.id, author: a.name, i18n, gmOnly: a.type === 'npc' ? true : undefined });
        return a.edge.current;
      },
    },

    // { actorId } or { all: true } (GM) / actorId: 'all'
    'edge/refresh': {
      role: 'any',
      handler(ctx, { actorId, all }) {
        if (all || actorId === 'all') {
          if (!ctx.isGM) ctx.fail('Réservé au MJ');
          const pcs = Object.values(ctx.state.actors).filter((a) => a.type === 'pc' && !a.retired);
          for (const a of pcs) a.edge.current = attr(a, 'EDG');
          ctx.log({ kind: 'system', author: 'MJ', i18n: { key: 'La Chance de tous les runners est rechargée.' } });
          return pcs.length;
        }
        const a = getActor(ctx, actorId);
        requireOwn(ctx, actorId);
        a.edge.current = attr(a, 'EDG');
        return a.edge.current;
      },
    },

    // See ARCHITECTURE.md + { skillId, attr, attr2, useSpec, applyWounds, bonus: [{label, value}] }
    'dice/roll': {
      role: 'any',
      handler(ctx, p) {
        const payload = p || {};
        let actor = null;
        if (payload.actorId) {
          actor = getActor(ctx, payload.actorId);
          if (!ctx.owns(payload.actorId)) ctx.fail('Tu ne peux lancer que pour ton personnage');
        }
        if (payload.secret && !ctx.isGM) ctx.fail('Seul le MJ peut faire un jet secret');
        const parts = [];
        let pool = 0;
        let label = str(payload.label, 120).trim();
        let defaultLimit = null;
        const skillId = payload.skillId ? String(payload.skillId) : null;
        const A1 = payload.attr && ATTRS.includes(payload.attr) ? payload.attr : null;
        const A2 = payload.attr2 && ATTRS.includes(payload.attr2) ? payload.attr2 : null;
        if ((skillId || A1) && !actor) ctx.fail('Choisis un personnage pour ce jet');
        if (skillId) {
          const sk = actor.skills.find((s) => s.id === skillId || s.name === skillId);
          const kno = !sk && actor.knowledge.find((k) => k.id === skillId);
          if (kno) {
            const at = A1 || (kno.type === 'academic' || kno.type === 'professional' ? 'LOG' : 'INT');
            const r = Number(kno.rating) || 0;
            const spec = payload.useSpec && String(kno.spec || '').trim() ? 2 : 0;
            pool = r + attr(actor, at) + spec;
            parts.push(`${kno.name} ${r}`, `${ATTR_SHORT[at]} ${attr(actor, at)}`);
            if (spec) parts.push('spé. +2');
            if (!label) label = kno.name;
            defaultLimit = 'mental';
          } else {
            const def = SKILL_BY_ID[skillId];
            const res = skillPool(actor, skillId, { useSpec: !!payload.useSpec, attrOverride: A1 || undefined });
            if (res.impossible) ctx.fail('{skill} ne peut pas être utilisée sans formation', { skill: def?.fr ? { t: def.fr } : sk?.name || skillId });
            const at = A1 || sk?.attr || def?.attr || 'AGI';
            pool = res.pool;
            if (res.defaulting) parts.push(`${ATTR_SHORT[at]} ${attr(actor, at)}`, 'par défaut −1');
            else {
              parts.push(`${sk?.name || def?.fr || skillId} ${sk.rating}`, `${ATTR_SHORT[at]} ${attr(actor, at)}`);
              if (payload.useSpec && sk.spec) parts.push(`spé. +2`);
            }
            if (!label) label = sk?.name || def?.fr || skillId;
            defaultLimit = skillDefaultLimit(def, at);
          }
        } else if (A1) {
          pool = attr(actor, A1);
          parts.push(`${ATTR_SHORT[A1]} ${pool}`);
          if (A2) {
            pool += attr(actor, A2);
            parts.push(`${ATTR_SHORT[A2]} ${attr(actor, A2)}`);
          }
          if (!label) label = A2 ? `${ATTR_LABELS[A1]} + ${ATTR_LABELS[A2]}` : ATTR_LABELS[A1];
        } else {
          pool = clampInt(payload.pool, 0, 100);
          parts.push(`${pool} dés`);
        }
        for (const b of Array.isArray(payload.bonus) ? payload.bonus.slice(0, 6) : []) {
          const v = clampInt(b?.value, -50, 50);
          if (!v) continue;
          pool += v;
          parts.push(`${str(b.label, 30) || 'bonus'} ${v > 0 ? '+' : '−'}${Math.abs(v)}`);
        }
        const mod = clampInt(payload.modifier, -50, 50);
        if (mod) {
          pool += mod;
          parts.push(`mod. ${mod > 0 ? '+' : '−'}${Math.abs(mod)}`);
        }
        if (payload.applyWounds && actor) {
          const w = derive(actor).woundModifier;
          if (w) {
            pool += w;
            parts.push(`blessures −${Math.abs(w)}`);
          }
        }
        const explode = !!payload.explode;
        if (explode) {
          if (!actor) ctx.fail('Choisis un personnage pour utiliser la Chance');
          if (actor.edge.current <= 0) ctx.fail('{name} n’a plus de point de Chance', { name: actor.name });
          const e = attr(actor, 'EDG');
          pool += e;
          parts.push(`Chance +${e}`);
        }
        pool = Math.min(100, pool);
        if (pool <= 0) ctx.fail('Réserve de dés nulle : échec automatique');
        let limit = null;
        let limitLabel = null;
        if (!explode) {
          // limit: number → that limit; null/0/'' → explicitly no limit; absent → default limit of the skill category.
          if (payload.limit !== undefined) {
            limit = clampInt(payload.limit, 0, 50) || null;
          } else if (defaultLimit && actor) {
            limit = derive(actor).limits[defaultLimit] || null;
            limitLabel = LIMIT_LABEL[defaultLimit];
          }
        }
        if (explode) actor.edge.current -= 1;
        const r = rollDice(pool, { limit, explode });
        if (!label) label = `Jet de ${pool} dés`;
        const roll = {
          ...r, label, explode, edge: explode, actorId: actor?.id || null, breakdown: parts.join(' + '),
          ...(limitLabel ? { limitLabel } : {}), ...(payload.secret ? { secret: true } : {}),
        };
        const author = actor ? actor.name : ctx.displayName();
        const hidden = !!payload.secret || (actor && actor.type === 'npc' && ctx.isGM && actor.hidden);
        const entry = ctx.log({ kind: 'roll', userId: ctx.user.id, author, text: label, roll, ...(hidden ? { gmOnly: true } : {}) });
        sfx(ctx, 'dice', hidden ? 'gm' : 'all');
        return { ...roll, logId: entry.id };
      },
    },

    // Edge « Seconde chance »: reroll every die that is not a hit. { logId }
    'dice/secondChance': {
      role: 'any',
      handler(ctx, { logId }) {
        const e = ctx.state.log.find((x) => x.id === logId);
        if (!e || e.kind !== 'roll' || !e.roll) ctx.fail('Jet introuvable');
        const r = e.roll;
        if (!r.actorId) ctx.fail('Ce jet n’est lié à aucun personnage');
        const a = getActor(ctx, r.actorId);
        requireOwn(ctx, r.actorId);
        if (r.explode) ctx.fail('Impossible : la Chance a déjà été utilisée pour ce jet (Repousser les limites)');
        if (r.secondChance) ctx.fail('Seconde chance déjà utilisée pour ce jet');
        if (a.edge.current <= 0) ctx.fail('{name} n’a plus de point de Chance', { name: a.name });
        a.edge.current -= 1;
        const before = [...r.dice];
        const rerolled = before.map((d) => (d >= 5 ? d : 1 + Math.floor(Math.random() * 6)));
        const raw = rerolled.filter((d) => d >= 5).length;
        r.secondChance = { before };
        r.dice = rerolled;
        r.rawHits = raw;
        r.hits = r.limit ? Math.min(raw, r.limit) : raw;
        r.limited = !!r.limit && raw > r.limit;
        r.edge = true;
        sfx(ctx, 'dice', e.gmOnly ? 'gm' : 'all');
        return { ...r };
      },
    },
  },

  filter(view, user) {
    const own = new Set(user.characterIds || []);
    for (const [id, a] of Object.entries(view.actors || {})) {
      if (!a) continue;
      delete a.gmNotes;
      if (a.npc) {
        delete a.npc.tactics;
        delete a.npc.loot;
      }
      if (own.has(id)) continue;
      if (a.type === 'npc') {
        if (a.hidden) {
          delete view.actors[id];
          continue;
        }
        view.actors[id] = { id, type: 'npc', name: a.name, portrait: a.portrait || '', color: a.color || '', metatype: a.metatype, templateId: a.templateId || null, status: statusOf(a) };
        continue;
      }
      delete a.notes;
    }
  },

  routes(app, { requireGM, getState, scheduleBroadcast, saveSoon, addLog }) {
    // POST /api/actors/import-chum5 (.chum5 or Actor JSON) is now served by the chummer module (85-chummer.js).

    // Export one actor as JSON (GM).
    app.get('/api/actors/:id/export', requireGM, (req, res) => {
      const a = getState().actors[req.params.id];
      if (!a) return res.status(404).json(errorBody('Personnage introuvable'));
      res.setHeader('Content-Disposition', `attachment; filename="${slugify(a.name)}.json"`);
      res.json(a);
    });
  },
};
