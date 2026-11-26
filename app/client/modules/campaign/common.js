// Campaign module — shared helpers and small components (GM pages + player dossiers).
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, Badge, Markdown, Modal, IconButton, loadCss } from '../../lib/ui.js';
import { api, send } from '../../lib/net.js';
import { toast, setUI, getUI } from '../../lib/ui-store.js';
import { t, tn, tk, locale, compare } from '../../lib/i18n.js';

loadCss('/modules/campaign/campaign.css');

// Labels are French keys (tk): render them with t(s.label) / t(s.one).
export const QUEST_STATUS = [
  { id: 'active', label: tk('quête::En cours'), color: 'cyan' },
  { id: 'upcoming', label: tk('quête::À venir'), color: 'amber' },
  { id: 'done', label: tk('quête::Terminée'), color: 'green' },
  { id: 'skipped', label: tk('quête::Ignorée'), color: 'dim' },
];
export const QUEST_STATUS_BY_ID = Object.fromEntries(QUEST_STATUS.map((s) => [s.id, s]));

export const THREAD_STATES = [
  { id: 'open', label: tk('fils::Ouverts'), one: tk('fil::Ouvert'), color: 'cyan' },
  { id: 'dormant', label: tk('fils::En sommeil'), one: tk('fil::En sommeil'), color: 'amber' },
  { id: 'resolved', label: tk('fils::Résolus'), one: tk('fil::Résolu'), color: 'green' },
  { id: 'dead', label: tk('fils::Abandonnés'), one: tk('fil::Abandonné'), color: 'dim' },
];
export const THREAD_STATE_BY_ID = Object.fromEntries(THREAD_STATES.map((s) => [s.id, s]));

export const cx = (...c) => c.filter(Boolean).join(' ');

/** Empty campaign slice so pages never crash before the server module is loaded. */
export function campaignOf(game) {
  const c = game?.campaign || {};
  return {
    acts: c.acts || [],
    quests: c.quests || [],
    sessions: c.sessions || [],
    threads: c.threads || [],
    handouts: c.handouts || [],
    playerRecap: c.playerRecap || '',
    notes: c.notes || '',
    currentActId: c.currentActId || null,
  };
}

/** Current act: GM override, else act of the first active quest, else first act with unfinished quests. */
export function currentAct(c) {
  const byId = (id) => c.acts.find((a) => a.id === id);
  if (c.currentActId && byId(c.currentActId)) return byId(c.currentActId);
  const active = c.quests.find((q) => q.status === 'active' && byId(q.actId));
  if (active) return byId(active.actId);
  const pending = c.quests.find((q) => q.status === 'upcoming' && byId(q.actId));
  return (pending && byId(pending.actId)) || c.acts[0] || null;
}

export function nextSession(c) {
  return [...c.sessions].sort((a, b) => a.number - b.number).find((s) => !s.played) || null;
}

/** localStorage key of the handouts a player has opened (DossiersPage + the « Dossiers » tab badge). */
export const handoutReadKey = (userId) => `sr.dossiers.read.${userId}`;

/** Number of handouts revealed to this player that they have not opened yet (0 for the GM). */
export function unreadHandouts(game) {
  if (!game || game.me?.role !== 'player') return 0;
  let read = [];
  try {
    const v = JSON.parse(localStorage.getItem(handoutReadKey(game.me.id)) || '[]');
    if (Array.isArray(v)) read = v;
  } catch {}
  const seen = new Set(read);
  return (game.campaign?.handouts || []).filter((h) => h && !seen.has(h.id)).length;
}

/** useState persisted in localStorage (per browser), tolerant to storage errors. */
export function usePersistent(key, initial) {
  const [v, setV] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : JSON.parse(raw);
    } catch {
      return initial;
    }
  });
  const set = (next) => {
    setV((prev) => {
      const val = typeof next === 'function' ? next(prev) : next;
      try {
        localStorage.setItem(key, JSON.stringify(val));
      } catch {}
      return val;
    });
  };
  return [v, set];
}

// ---------------------------------------------------------------------------
// Lookups into other modules' slices (all optional — ids may not exist yet)
// ---------------------------------------------------------------------------
/** 'tpl_dorian_ashe' -> 'Dorian Ashe' (display name for links whose target does not exist yet). */
export function prettyId(id) {
  const words = String(id || '').replace(/^(tpl|map|npc|act)_/, '').split(/[_-]+/).filter(Boolean);
  return words.map((w) => (/^r\d+$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ') || String(id);
}

/**
 * Template id actually present in the bestiary: exact id, else a unique template sharing the last
 * id segment (tolerates renames such as tpl_reyes -> tpl_agc_reyes). null if none.
 */
export function resolveTemplateId(game, id) {
  const b = game.bestiary || {};
  if (b[id]) return id;
  const tail = String(id || '').replace(/^tpl_/, '').split('_').pop();
  if (!tail || tail.length < 4) return null;
  const hits = Object.keys(b).filter((k) => k.split('_').pop() === tail);
  return hits.length === 1 ? hits[0] : null;
}

export function npcInfo(game, id) {
  const tid = resolveTemplateId(game, id);
  const tpl = tid && game.bestiary[tid];
  if (tpl) return { id: tid, name: tpl.name || tid, kind: 'template', folder: tpl.folder || '' };
  const a = game.actors?.[id];
  if (a) return { id, name: a.name || id, kind: 'actor', folder: a.type === 'pc' ? t('PJ') : t('PNJ en jeu') };
  return { id, name: prettyId(id), kind: 'missing', folder: '' };
}

export function mapInfo(game, id) {
  const m = game.maps?.[id];
  return m ? { id, name: m.name || id, exists: true, folder: m.folder || '' } : { id, name: prettyId(id), exists: false, folder: '' };
}

export function templateOptions(game) {
  return Object.entries(game.bestiary || {})
    .map(([id, tpl]) => ({ id, name: tpl?.name || id, folder: tpl?.folder || t('Divers') }))
    .sort((a, b) => compare(a.folder, b.folder) || compare(a.name, b.name));
}

export function mapOptions(game) {
  return Object.entries(game.maps || {})
    .map(([id, m]) => ({ id, name: m?.name || id, folder: m?.folder || '' }))
    .sort((a, b) => compare(a.folder, b.folder) || compare(a.name, b.name));
}

/** Group options by folder into <optgroup>s. */
export function groupedOptions(list) {
  const groups = new Map();
  for (const o of list) {
    const g = o.folder || t('Divers');
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(o);
  }
  return [...groups.entries()].map(
    ([label, items]) => html`<optgroup label=${label}>${items.map((o) => html`<option value=${o.id}>${o.name}</option>`)}</optgroup>`
  );
}

// ---------------------------------------------------------------------------
// Quick actions owned by other modules
// ---------------------------------------------------------------------------
export async function spawnNpc(game, linkedId, { hidden = false, count = 1 } = {}) {
  const templateId = resolveTemplateId(game, linkedId) || linkedId;
  const mapId = (getUI().viewMapId && game.maps?.[getUI().viewMapId] ? getUI().viewMapId : null) || game.scene?.activeMapId || undefined;
  try {
    const res = await send('bestiary/spawn', { templateId, mapId, count, hidden });
    const name = npcInfo(game, templateId).name;
    const placed = Array.isArray(res?.tokenIds) ? res.tokenIds.length : count;
    if (placed) {
      const map = mapId ? mapInfo(game, mapId).name : '';
      let msg;
      if (map) msg = hidden ? tn(placed, '{name} placé sur la carte « {map} » (caché)', '{name} placés sur la carte « {map} » (caché)', { name, map }) : tn(placed, '{name} placé sur la carte « {map} »', '{name} placés sur la carte « {map} »', { name, map });
      else msg = hidden ? tn(placed, '{name} placé sur la carte (caché)', '{name} placés sur la carte (caché)', { name }) : tn(placed, '{name} placé sur la carte', '{name} placés sur la carte', { name });
      toast(msg, 'success');
    } else toast(t("{name} créé, mais aucune carte n'est affichée (ou plus de place libre)", { name }), 'warn');
  } catch {}
}

export async function showMapToPlayers(game, mapId) {
  try {
    await send('maps/setActive', { mapId });
    toast(t('Carte affichée aux joueurs : {map}', { map: mapInfo(game, mapId).name }), 'success');
  } catch {}
}

/** Reveal a handout ('all' or [userId]) with a confirmation toast. */
export async function revealHandout(handoutId, to) {
  try {
    const res = await send('campaign/revealHandout', { handoutId, to });
    const n = Array.isArray(res?.notified) ? res.notified.length : 0;
    toast(to === 'all' ? t('Document révélé à tous les joueurs') : n ? t('Document envoyé') : t('Ce joueur l’avait déjà'), n || to === 'all' ? 'success' : 'info');
  } catch {}
}

export function openMap(mapId) {
  setUI({ viewMapId: mapId, mainTab: 'map' });
}

// ---------------------------------------------------------------------------
// Campaign documents (GM): cached list from GET /api/docs
// ---------------------------------------------------------------------------
let docsCache = null;
const docsListeners = new Set();
export function reloadDocs() {
  docsCache = api('/api/docs')
    .then((list) => (Array.isArray(list) ? list : []))
    .catch((err) => {
      docsCache = null;
      throw err;
    });
  const p = docsCache;
  p.then((list) => docsListeners.forEach((l) => l({ list, error: null }))).catch((err) => docsListeners.forEach((l) => l({ list: [], error: err.message || t('Erreur') })));
  return p;
}
export function useDocs() {
  const [s, setS] = useState({ list: [], error: null, loading: true });
  useEffect(() => {
    let alive = true;
    const l = (v) => alive && setS({ ...v, loading: false });
    docsListeners.add(l);
    (docsCache || reloadDocs()).then((list) => l({ list, error: null })).catch((err) => l({ list: [], error: err.message || t('Erreur') }));
    return () => {
      alive = false;
      docsListeners.delete(l);
    };
  }, []);
  return s;
}

/** 'file.md#Heading' -> { name, anchor } */
export function parseDocRef(ref) {
  if (!ref) return null;
  const i = ref.indexOf('#');
  return i < 0 ? { name: ref, anchor: '' } : { name: ref.slice(0, i), anchor: ref.slice(i + 1) };
}

export function docTitle(name) {
  const base = String(name || '').replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : name;
}

/** Select of campaign docs (keeps the current value even if the file is gone). */
export function DocSelect({ value, onChange, docs }) {
  const ref = parseDocRef(value);
  const name = ref?.name || '';
  const known = docs.some((d) => d.name === name);
  return html`<select class="input camp-doc-select" value=${name} onChange=${(e) => onChange(e.target.value)}>
    <option value="">${t('— Aucun document —')}</option>
    ${name && !known && html`<option value=${name}>${t('{name} (introuvable)', { name })}</option>`}
    ${docs.map((d) => html`<option value=${d.name}>${docTitle(d.name)}</option>`)}
  </select>`;
}

/** Button that opens a doc reference in the Documents tab. */
export function DocButton({ docRef, nav, small = true, label }) {
  const r = parseDocRef(docRef);
  if (!r) return null;
  return html`<button class=${cx('btn btn-ghost camp-doc-btn', small && 'btn-sm')} title=${t('Ouvrir {doc}', { doc: docRef })} onClick=${(e) => {
    e.stopPropagation();
    nav.openDoc(docRef);
  }}>
    <span class="camp-ico">❐</span> ${label || docTitle(r.name)}${r.anchor ? html`<span class="faint"> › ${r.anchor}</span>` : null}
  </button>`;
}

// ---------------------------------------------------------------------------
// Markdown editor: write / preview / side by side. Commits on blur, Ctrl+S, or unmount.
// ---------------------------------------------------------------------------
export function MdEditor({ value, onSave, rows = 8, placeholder = '', initialMode = 'preview', emptyText, label, class: klass, tall }) {
  const [mode, setMode] = useState(initialMode);
  const [draft, setDraft] = useState(value || '');
  const [dirty, setDirty] = useState(false);
  const r = useRef({});
  r.current.draft = draft;
  r.current.dirty = dirty;
  r.current.value = value || '';
  r.current.onSave = onSave;

  useEffect(() => {
    if (!r.current.dirty) setDraft(value || '');
  }, [value]);

  const commit = () => {
    if (!r.current.dirty) return;
    r.current.dirty = false;
    setDirty(false);
    if (r.current.draft !== r.current.value) r.current.onSave?.(r.current.draft);
  };
  // Never lose a draft when the editor disappears (tab switch, collapse…).
  useEffect(() => () => {
    if (r.current.dirty && r.current.draft !== r.current.value) r.current.onSave?.(r.current.draft);
  }, []);

  const onKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'Enter')) {
      e.preventDefault();
      commit();
    }
    if (e.key === 'Tab' && !e.shiftKey && e.target.selectionStart === e.target.selectionEnd) {
      // Insert two spaces instead of leaving the field (lists indentation).
      e.preventDefault();
      const ta = e.target;
      const s = ta.selectionStart;
      const next = ta.value.slice(0, s) + '  ' + ta.value.slice(s);
      setDraft(next);
      setDirty(true);
      requestAnimationFrame(() => ta.setSelectionRange(s + 2, s + 2));
    }
  };

  const textarea = html`<textarea class="input camp-md-input" rows=${rows} value=${draft} placeholder=${placeholder}
    onInput=${(e) => {
      setDraft(e.target.value);
      setDirty(true);
    }}
    onBlur=${commit} onKeyDown=${onKeyDown}></textarea>`;
  const preview = draft.trim()
    ? html`<${Markdown} class="camp-md-preview" text=${draft} />`
    : html`<div class="camp-md-preview camp-md-empty" onDblClick=${() => setMode('edit')}>${emptyText ?? t('Vide — clique sur « Écrire » pour rédiger.')}</div>`;

  const modes = [
    { id: 'preview', label: t('Aperçu') },
    { id: 'edit', label: t('Écrire') },
    { id: 'split', label: t('Côte à côte') },
  ];
  return html`<div class=${cx('camp-md', `camp-md-${mode}`, tall && 'camp-md-tall', klass)}>
    <div class="camp-md-bar">
      ${label && html`<span class="camp-md-label">${label}</span>`}
      <span class="grow"></span>
      ${dirty
        ? html`<button class="camp-md-save" title=${t('Enregistrer (Ctrl+S)')} onMouseDown=${(e) => e.preventDefault()} onClick=${commit}>● ${t('Enregistrer')}</button>`
        : null}
      <div class="camp-seg">
        ${modes.map((m) => html`<button class=${cx(m.id === mode && 'active', m.id === 'split' && 'camp-seg-wide')} onMouseDown=${(e) => e.preventDefault()} onClick=${() => {
          commit();
          setMode(m.id);
        }}>${m.label}</button>`)}
      </div>
    </div>
    <div class="camp-md-body" onDblClick=${mode === 'preview' ? () => setMode('edit') : undefined}>
      ${mode === 'preview' ? preview : mode === 'edit' ? textarea : html`${textarea}${preview}`}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
export function fmtDate(ts, withTime = true) {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(locale(), withTime ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'long', year: 'numeric' });
}

export function fmtSessionDate(s) {
  if (!s) return '';
  const d = new Date(s + (s.length === 10 ? 'T12:00:00' : ''));
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Handout card (player dossier look) — used by DossiersPage and the GM preview.
// ---------------------------------------------------------------------------
export function HandoutCard({ handout, unread, open = true, onToggle, stamp }) {
  const [zoom, setZoom] = useState(false);
  const h = handout;
  return html`<article class=${cx('dos-card', unread && 'unread', open && 'open')}>
    <header class="dos-card-head" onClick=${onToggle} role=${onToggle ? 'button' : undefined}>
      <span class="dos-tab"></span>
      <div class="grow">
        <div class="dos-card-meta">
          <span class="dos-stamp">${stamp ?? t('Confidentiel')}</span>
          ${h.revealedAt && html`<span class="faint small">${t('reçu {date}', { date: fmtDate(h.revealedAt) })}</span>`}
          ${unread && html`<${Badge} color="magenta">${t('Nouveau')}</${Badge}>`}
        </div>
        <h3 class="dos-card-title">${h.title}</h3>
      </div>
      ${onToggle && html`<span class=${cx('camp-chev', open && 'open')}>›</span>`}
    </header>
    ${open &&
    html`<div class="dos-card-body">
      ${h.image &&
      html`<button class="dos-img" title=${t('Agrandir')} onClick=${() => setZoom(true)}><img src=${h.image} alt=${h.title} loading="lazy" /></button>`}
      ${h.body ? html`<${Markdown} class="dos-md" text=${h.body} />` : !h.image && html`<div class="faint small">${t('Document vide.')}</div>`}
    </div>`}
    ${zoom &&
    html`<${Modal} title=${h.title} width=${1200} onClose=${() => setZoom(false)}>
      <img class="dos-zoom" src=${h.image} alt=${h.title} />
    </${Modal}>`}
  </article>`;
}

/** Small inline confirm-free "remove" chip button. */
export function ChipX({ onClick, title }) {
  return html`<${IconButton} icon="✕" class="camp-chip-x" title=${title || t('Retirer')} onClick=${(e) => {
    e.stopPropagation();
    onClick();
  }} />`;
}
