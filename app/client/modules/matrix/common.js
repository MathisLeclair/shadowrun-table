// Matrix UI helpers shared by the decker cockpit and the GM screens.
import { html, Badge } from '../../lib/ui.js';
import { send, useCatalog } from '../../lib/net.js';
import { BookRef } from '../books/BookRef.js';
import { setUI } from '../../lib/ui-store.js';
import { DiceFaces, fmtTime } from '../sheet/common.js';
import { t, tn, tk, tIfKnown, getLang, skillLabel, compare, logText } from '../../lib/i18n.js';
import {
  OS_MAX, osLevel, IC_TYPES, matrixMonitor, identityAsdf, isCyberdeck, ACTION_BY_ID, MAX_MARKS, PROGRAM_BY_ID, programId,
  ASDF_LABELS, ASDF_SHORT, ASDF_SHORT_EN, MODE_LABELS, DEVICE_LINK_KINDS,
} from '/shared/matrix.js';

export const isGM = (game) => game?.me?.role === 'gm';

// ---------------------------------------------------------------------------
// i18n helpers. The server and shared/matrix.js send French labels plus translatable messages:
// msgs = [{ t: 'French key {x}', params }], pool parts { label, key?, params?, skillId?, attr? }, names with nameI18n.
// ---------------------------------------------------------------------------
/** A message from the server ({ t, params } / { key, params }) or a plain French string, in the UI language. */
export function msgText(m) {
  if (m === null || m === undefined) return '';
  if (typeof m === 'string') return tIfKnown(m);
  if (typeof m.t === 'string') return t(m.t, m.params);
  if (typeof m.key === 'string') return t(m.key, m.params);
  return '';
}
/** Outcome sentences of an action result (msgs when the server sent them, else the French outcomes). */
export const outcomeTexts = (res) => (Array.isArray(res?.msgs) ? res.msgs.map(msgText) : (res?.outcomes || []).map((o) => tIfKnown(o)));
/** Label of a dice pool / limit part. French: the label as computed; English: key, official skill name, attribute code. */
export function partLabel(p) {
  if (!p) return '';
  if (getLang() === 'fr') return p.label;
  if (p.key) return t(p.key, p.params);
  if (p.skillId) return skillLabel(p.skillId);
  if (p.attr) return p.attr;
  return tIfKnown(p.label);
}
/** Name of a Matrix action in the UI language. */
export const actionName = (a) => (a ? t(a.fr) : '');
/** Name of an IC type ('killer') in the UI language. */
export const icName = (type) => (IC_TYPES[type] ? t(IC_TYPES[type].fr) : String(type || 'IC'));
/** Name of a mark entry (generated names carry nameI18n). */
export const markName = (m) => (m?.nameI18n ? msgText(m.nameI18n) : m?.name || '');
/** IC holding a link-lock (older saves only stored the French name). */
export const linkLockName = (ll) => (ll?.icType ? t('{ic} ({host})', { ic: { t: IC_TYPES[ll.icType]?.fr || 'IC' }, host: ll.hostName || '' }) : ll?.name || '');
/** Program name: stored as typed (French UI), official English name of a known program in English. */
export function programLabel(name) {
  if (getLang() === 'fr') return name;
  const def = PROGRAM_BY_ID[programId(name)];
  if (!def) return name;
  const m = String(name).match(/\((\d+)\)\s*$|\s(\d+)\s*$/);
  return def.id === 'agent' && m ? `${def.en} (${m[1] || m[2]})` : def.en;
}
/** Author of a matrix log entry (agents and IC carry authorI18n). */
export const logAuthor = (e) => (e?.authorI18n?.key ? t(e.authorI18n.key, e.authorI18n.params) : e?.author === 'MJ' ? t('MJ') : e?.author || '');
/** Roll label of a matrix log entry. */
export const logRollLabel = (r) => (r?.labelI18n?.key ? t(r.labelI18n.key, r.labelI18n.params) : tIfKnown(r?.label || ''));
/** One-letter ASDF slot: A/C/T/F in French, A/S/D/F in English. */
export const asdfShort = (k) => (getLang() === 'en' ? ASDF_SHORT_EN[k] : ASDF_SHORT[k]) || k;
/** Matrix attribute name (Attaque / Attack…). */
export const asdfLabel = (k) => (ASDF_LABELS[k] ? t(ASDF_LABELS[k]) : String(k || ''));
/** Connection mode (RA / RV froide / RV chaude). */
export const modeLabel = (m) => (MODE_LABELS[m] ? t(MODE_LABELS[m]) : String(m || ''));
/** Pending agent assist bonus: « +2 dés, limite +1 ». */
export const assistText = (pa) =>
  pa?.limitBonus ? tn(pa.dice, '+{n} dé, limite +1', '+{n} dés, limite +1') : tn(pa?.dice || 0, '+{n} dé', '+{n} dés');
/** An agent the actor owns (detectAgents): gear labels are rebuilt in the UI language. */
export const agentLabel = (o) => (o?.source === 'gear' && o.gearRating ? t('{name} (indice {n})', { name: o.name, n: o.gearRating }) : o?.source === 'gear' ? o.label : programLabel(o?.label || ''));
/** « 2 marques ». */
export const marksText = (n) => tn(n, '{n} marque', '{n} marques');
export const ownsActor = (game, id) => isGM(game) || (game?.me?.characterIds || []).includes(id);

/** Send an action, swallowing the rejection (the net layer already shows an error toast). */
export const act = (type, payload) => send(type, payload).catch(() => null);

/** Stored persona, or a blank client-side one before the first connection. */
export function personaOf(game, actor) {
  const p = game.matrix?.personas?.[actor.id];
  if (p) return p;
  return {
    actorId: actor.id, online: false, mode: 'cold', asdf: identityAsdf(), loadedPrograms: [], marks: [], marksOnMe: [],
    overwatch: 0, matrixDamage: 0, noise: 0, hostId: null, penalties: {}, files: [], programSlots: null, agent: null, virtual: true,
  };
}

/** Actors a user may pilot in the Matrix (own PCs with a device; GM: every actor with a device). */
export function matrixActors(game) {
  const list = Object.values(game.actors || {}).filter((a) => a && a.matrix && a.attributes);
  const mine = isGM(game) ? list : list.filter((a) => (game.me.characterIds || []).includes(a.id));
  return mine.sort((a, b) => (isCyberdeck(b) - isCyberdeck(a)) || (a.type === b.type ? compare(a.name, b.name) : a.type === 'pc' ? -1 : 1));
}

export const marksDots = (n, max = MAX_MARKS) =>
  html`<span class="mx-dots" title=${marksText(n)}>${Array.from({ length: max }, (_, i) => html`<i class=${i < n ? 'on' : ''}></i>`)}</span>`;

/** Overwatch meter 0-40 with thresholds and a loud warning near convergence. */
export function OsMeter({ value, hidden, knownAt, compact }) {
  if (hidden && (value === null || value === undefined)) {
    return html`<div class="mx-os mx-os-unknown">
      <div class="mx-os-head"><span>${t('Score d’Overwatch')}</span><b class="mono">??</b></div>
      <div class="mx-os-bar"><div class="mx-os-fog"></div></div>
      <div class="small muted">${t('Inconnu : utilise « Vérifier le Score d’Overwatch » ou le programme Surveillance.')}</div>
    </div>`;
  }
  const v = Math.max(0, Math.min(OS_MAX, Number(value) || 0));
  const lvl = osLevel(v);
  const segs = [];
  for (let i = 0; i < OS_MAX; i++) {
    const zone = i >= 30 ? 'red' : i >= 20 ? 'amber' : i >= 10 ? 'cyan' : 'green';
    segs.push(html`<span class=${`mx-os-seg z-${zone}${i < v ? ' on' : ''}`}></span>`);
  }
  return html`<div class=${`mx-os lvl-${lvl.id}${compact ? ' compact' : ''}`}>
    <div class="mx-os-head">
      <span>${t('Score d’Overwatch')}${hidden ? html` <span class="faint small">${knownAt ? t('(dernière vérification {time})', { time: fmtTime(knownAt) }) : t('(dernière vérification)')}</span>` : ''}</span>
      <b class="mono">${v}<small>/${OS_MAX}</small></b>
    </div>
    <div class="mx-os-bar">${segs}</div>
    ${!compact && html`<div class="mx-os-foot"><${Badge} color=${lvl.color}>${t(lvl.label)}</${Badge}><span class="faint small">${t('Convergence à {n}', { n: OS_MAX })}</span></div>`}
    ${!compact && v >= 35 && html`<div class="mx-os-alarm">${t('CONVERGENCE IMMINENTE — déconnecte-toi ou redémarre ton deck !')}</div>`}
    ${!compact && v >= 30 && v < 35 && html`<div class="mx-os-warn">${t('Le GOD se rapproche : chaque action illégale peut déclencher la convergence.')}</div>`}
  </div>`;
}

/** Matrix condition monitor as boxes. onSet(n) makes boxes clickable (GM). */
export function MatrixMonitor({ value, deviceRating, onSet, label, max }) {
  const mon = max || matrixMonitor(deviceRating);
  const v = Math.min(mon, Number(value) || 0);
  return html`<div class="mx-monitor">
    <div class="mx-monitor-head"><span>${label || t('Moniteur matriciel')}</span><span class="mono">${v}/${mon}</span></div>
    <div class="mx-boxes">
      ${Array.from({ length: mon }, (_, i) => html`<button type="button" class=${'mx-box' + (i < v ? ' on' : '')} disabled=${!onSet}
        title=${onSet ? t('Mettre à {n}', { n: i + 1 === v ? i : i + 1 }) : ''} onClick=${() => onSet?.(i + 1 === v ? i : i + 1)}></button>`)}
    </div>
  </div>`;
}

/** Human label of a log entry's dice outcome. */
function HitsBadge({ e }) {
  const r = e.roll;
  if (!r) return null;
  const mx = e.matrix || {};
  return html`<span class=${'mx-log-hits' + (mx.success === true ? ' ok' : mx.success === false ? ' ko' : '')}>
    ${r.hits}${typeof mx.defenseHits === 'number' ? html`<small> ${t('vs {n}', { n: mx.defenseHits })}</small>` : null}
  </span>`;
}

/** Recent matrix log entries (kind 'matrix'), optionally limited to one actor. */
export function MatrixLog({ game, actorId, limit = 14, title }) {
  const entries = (game.log || []).filter((e) => e.kind === 'matrix' && (!actorId || !e.matrix?.actorId || e.matrix.actorId === actorId)).slice(-limit).reverse();
  return html`<div class="mx-log">
    <div class="mx-panel-title">${title || t('Journal matriciel')}</div>
    ${entries.length === 0 && html`<div class="muted small">${t('Rien pour l’instant.')}</div>`}
    ${entries.map((e) => html`<div class=${'mx-log-entry' + (e.gmOnly ? ' gm' : '') + (e.matrix?.event === 'convergence' ? ' conv' : '')} key=${e.id}>
      <div class="mx-log-meta"><b>${logAuthor(e)}</b>${e.gmOnly ? html`<span class="ld-tag">${t('MJ')}</span>` : null}<span class="mono faint">${fmtTime(e.ts)}</span></div>
      ${e.roll && html`<div class="mx-log-roll"><span class="mx-log-label">${logRollLabel(e.roll)}</span><${HitsBadge} e=${e} /></div>`}
      ${e.roll && html`<${DiceFaces} roll=${e.roll} small />`}
      <div class="mx-log-text">${logText(e)}</div>
    </div>`)}
  </div>`;
}

/** Targets available to a persona for an action: [{ group, items: [{ id, label, kind, marks }] }]. */
export function targetOptions(game, actor, persona, action) {
  const allow = new Set(action?.targets || []);
  const gm = isGM(game);
  const hosts = Object.values(game.matrix?.hosts || {});
  const markOn = (key, hostId) => {
    const own = (persona.marks || []).find((m) => m.targetId === key)?.count || 0;
    const viaHost = hostId ? (persona.marks || []).find((m) => m.targetId === `host:${hostId}`)?.count || 0 : 0;
    return Math.max(own, viaHost);
  };
  const groups = [];
  if (allow.has('host')) {
    const items = hosts.filter((h) => gm || h.visible || h.inside || markOn(`host:${h.id}`)).map((h) => ({ id: `host:${h.id}`, label: h.name, kind: 'host', marks: markOn(`host:${h.id}`) }));
    if (items.length) groups.push({ group: t('Hôtes'), items });
  }
  const cur = persona.hostId ? hosts.find((h) => h.id === persona.hostId) : null;
  if (allow.has('ic') && cur) {
    const items = (cur.ic || []).filter((ic) => gm ? ic.active : true).map((ic) => ({
      id: `ic:${cur.id}:${ic.id}`, kind: 'ic', marks: markOn(`ic:${cur.id}:${ic.id}`, cur.id),
      label: `${icName(ic.type)}${ic.rating ? ` ${t('(indice {n})', { n: ic.rating })}` : ''}${ic.damage ? ` — ${ic.damage}/${matrixMonitor(ic.rating)}` : ''}`,
    }));
    if (items.length) groups.push({ group: t('IC — {host}', { host: cur.name }), items });
  }
  if (allow.has('file') && cur) {
    const items = (cur.files || []).map((f) => ({
      id: `file:${cur.id}:${f.id}`, kind: 'file', marks: markOn(`file:${cur.id}:${f.id}`, cur.id),
      label: `${f.name}${f.protected ? ` ${t('[protégé]')}` : ''}${f.bomb ? ` ${t('[bombe {n}]', { n: f.bomb })}` : ''}`,
    }));
    if (items.length) groups.push({ group: t('Fichiers — {host}', { host: cur.name }), items });
  }
  if (allow.has('device')) {
    for (const h of hosts) {
      if (!gm && h.id !== persona.hostId && !h.perceived) continue;
      const items = (h.devices || []).map((d) => ({
        id: `device:${h.id}:${d.id}`, kind: 'device', marks: markOn(`device:${h.id}:${d.id}`, h.id), linkKind: d.link?.kind || null,
        label: `${d.link?.kind && DEVICE_LINK_KINDS[d.link.kind] ? `${DEVICE_LINK_KINDS[d.link.kind].icon} ` : ''}${d.name}${d.offline ? ` ${t('(hors ligne)')}` : ''}`,
      }));
      if (items.length) groups.push({ group: t('Appareils — {host}', { host: h.name }), items });
    }
  }
  if (allow.has('persona')) {
    const items = Object.values(game.actors || {})
      .filter((a) => a && a.id !== actor.id && !a.retired && (a.matrix || a.type === 'npc'))
      .sort((a, b) => (a.type === b.type ? compare(a.name, b.name) : a.type === 'pc' ? -1 : 1))
      .map((a) => ({ id: `persona:${a.id}`, kind: 'persona', marks: markOn(`persona:${a.id}`), label: `${a.name}${a.type === 'npc' ? ` ${t('(PNJ)')}` : ''}` }));
    if (items.length) groups.push({ group: t('Personas'), items });
  }
  if (allow.has('markOnMe')) {
    const items = (persona.marksOnMe || []).filter((m) => m.count > 0).map((m) => ({ id: `mark:${m.sourceId}`, kind: 'markOnMe', marks: 0, label: `${markName(m)} (${marksText(m.count)})` }));
    if (items.length) groups.push({ group: t('Marques sur moi'), items });
  }
  if (allow.has('manual')) groups.push({ group: t('Autre'), items: [{ id: 'manual', kind: 'manual', marks: 0, label: t('Autre cible…') }] });
  return groups;
}

/**
 * State of the map object a host device is linked to: 'open'|'closed'|'locked' (door), 'on'|'off' (light, cameras), or null.
 * Players receive it from the server (device.link.state); the GM computes it from the maps.
 */
export function deviceLinkState(game, device) {
  const l = device?.link;
  if (!l) return null;
  if (l.state !== undefined) return l.state;
  const map = game.maps?.[l.mapId];
  if (!map) return null;
  if (l.kind === 'door') {
    const d = (map.doors || []).find((x) => x.id === l.targetId) || (map.walls || []).find((x) => x.id === l.targetId)?.door;
    return d ? d.state : null;
  }
  if (l.kind === 'light') {
    const li = (map.lights || []).find((x) => x.id === l.targetId);
    return li ? (li.on ? 'on' : 'off') : null;
  }
  const r = (map.regions || []).find((x) => x.id === l.targetId);
  return r ? r.cams || 'on' : null;
}
const LINK_STATE_LABELS = { open: tk('ouverte'), closed: tk('fermée'), locked: tk('verrouillée'), on: tk('allumé'), off: tk('coupé') };
/** « 🚪 verrouillée » — the link's icon and current state. */
export function linkStateText(kind, state) {
  const icon = DEVICE_LINK_KINDS[kind]?.icon || '';
  if (kind === 'camera' && state === 'on') return `${icon} ${t('filme')}`;
  return state && LINK_STATE_LABELS[state] ? `${icon} ${t(LINK_STATE_LABELS[state])}` : icon;
}

/** Marks required by an action (Control Device: chosen 1-3). */
export function marksRequired(action, opts = {}) {
  if (!action) return 0;
  if (action.id === 'controlDevice') return Math.max(1, Math.min(3, Number(opts.controlMarks) || 1));
  if (action.marksOnOwner) return 0;
  return action.marks || 0;
}

export const actionById = (id) => ACTION_BY_ID[id] || null;

/** Open the Matrix tab on an actor's cockpit (closes the sheet modal). Used by the sheet's Matrice tab. */
export function openMatrix(actorId) {
  setUI({ mainTab: 'matrix', sheetActorId: null, matrixFocus: { actorId, nonce: Date.now() } });
}

/** 📖 chip of a program stored by name: its entry in the programs catalog (official English name, French name or alias). */
export function ProgramRef({ name }) {
  const progs = useCatalog('programs');
  if (!Array.isArray(progs) || !progs.length) return null;
  const def = PROGRAM_BY_ID[programId(name)];
  const keys = new Set([name, def?.en, def?.fr].filter(Boolean).map((x) => String(x).trim().toLowerCase()));
  const e = progs.find((x) => keys.has(String(x.name).toLowerCase()) || keys.has(String(x.nameFr || '').toLowerCase()));
  return e ? html` <${BookRef} source=${e.source} page=${e.page} />` : null;
}
