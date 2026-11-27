// Campaign module — shared helpers and small components (GM pages + player dossiers).
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Badge, Markdown, Modal, IconButton } from '../../lib/ui.tsx';
import { api, send } from '../../lib/net.ts';
import { toast, setUI, getUI } from '../../lib/ui-store.ts';
import { t, tn, tk, locale, compare } from '../../lib/i18n.ts';
import type { Campaign, GameView, QuestStatus, ThreadState } from '../../../shared/types.ts';
import type { CampaignNav, DocMeta, DocsState, HandoutLike } from './types.ts';
import './campaign.css';

// Labels are English UI keys (tk): render them with t(s.label) / t(s.one).
export const QUEST_STATUS: Array<{ id: QuestStatus; label: string; color: string }> = [
  { id: 'active', label: tk('quest::Active'), color: 'cyan' },
  { id: 'upcoming', label: tk('quest::Upcoming'), color: 'amber' },
  { id: 'done', label: tk('quest::Done'), color: 'green' },
  { id: 'skipped', label: tk('quest::Skipped'), color: 'dim' },
];
export const QUEST_STATUS_BY_ID: Record<string, (typeof QUEST_STATUS)[number]> = Object.fromEntries(QUEST_STATUS.map((s) => [s.id, s]));

export const THREAD_STATES: Array<{ id: ThreadState; label: string; one: string; color: string }> = [
  { id: 'open', label: tk('threads::Open'), one: tk('thread::Open'), color: 'cyan' },
  { id: 'dormant', label: tk('threads::Dormant'), one: tk('thread::Dormant'), color: 'amber' },
  { id: 'resolved', label: tk('threads::Resolved'), one: tk('thread::Resolved'), color: 'green' },
  { id: 'dead', label: tk('threads::Abandoned'), one: tk('thread::Abandoned'), color: 'dim' },
];
export const THREAD_STATE_BY_ID: Record<string, (typeof THREAD_STATES)[number]> = Object.fromEntries(THREAD_STATES.map((s) => [s.id, s]));

export const cx = (...c: unknown[]): string => c.filter(Boolean).join(' ');

/** Normalized GM campaign slice (see campaignOf). */
export type CampaignData = Omit<Campaign, '_seed'>;

/** Empty campaign slice so pages never crash before the server module is loaded. */
export function campaignOf(game: GameView | null | undefined): CampaignData {
  const c = (game?.campaign || {}) as Partial<Campaign>;
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
export function currentAct(c: CampaignData) {
  const byId = (id: string | null) => c.acts.find((a) => a.id === id);
  if (c.currentActId && byId(c.currentActId)) return byId(c.currentActId)!;
  const active = c.quests.find((q) => q.status === 'active' && byId(q.actId));
  if (active) return byId(active.actId)!;
  const pending = c.quests.find((q) => q.status === 'upcoming' && byId(q.actId));
  return (pending && byId(pending.actId)) || c.acts[0] || null;
}

export function nextSession(c: CampaignData) {
  return [...c.sessions].sort((a, b) => a.number - b.number).find((s) => !s.played) || null;
}

/** localStorage key of the handouts a player has opened (DossiersPage + the « Dossiers » tab badge). */
export const handoutReadKey = (userId: string) => `sr.dossiers.read.${userId}`;

/** Number of handouts revealed to this player that they have not opened yet (0 for the GM). */
export function unreadHandouts(game: GameView | null | undefined): number {
  if (!game || game.me?.role !== 'player') return 0;
  let read: string[] = [];
  try {
    const v = JSON.parse(localStorage.getItem(handoutReadKey(game.me.id)) || '[]');
    if (Array.isArray(v)) read = v;
  } catch {}
  const seen = new Set(read);
  return (game.campaign?.handouts || []).filter((h) => h && !seen.has(h.id)).length;
}

export type SetPersistent<T> = (next: T | ((prev: T) => T)) => void;

/** useState persisted in localStorage (per browser), tolerant to storage errors. */
export function usePersistent<T>(key: string, initial: T): [T, SetPersistent<T>] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : JSON.parse(raw);
    } catch {
      return initial;
    }
  });
  // Latest value: the next value is computed and stored at once (React runs state updaters lazily, and the
  // shell reads localStorage right away — e.g. the « Dossiers » tab badge after setUI()).
  const cur = useRef(v);
  cur.current = v;
  const set: SetPersistent<T> = (next) => {
    const val = typeof next === 'function' ? (next as (prev: T) => T)(cur.current) : next;
    cur.current = val;
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch {}
    setV(val);
  };
  return [v, set];
}

// ---------------------------------------------------------------------------
// Lookups into other modules' slices (all optional — ids may not exist yet)
// ---------------------------------------------------------------------------
/** 'tpl_dorian_ashe' -> 'Dorian Ashe' (display name for links whose target does not exist yet). */
export function prettyId(id: string | null | undefined): string {
  const words = String(id || '').replace(/^(tpl|map|npc|act)_/, '').split(/[_-]+/).filter(Boolean);
  return words.map((w) => (/^r\d+$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ') || String(id);
}

/**
 * Template id actually present in the bestiary: exact id, else a unique template sharing the last
 * id segment (tolerates renames such as tpl_reyes -> tpl_agc_reyes). null if none.
 */
export function resolveTemplateId(game: GameView, id: string): string | null {
  const b = game.bestiary || {};
  if (b[id]) return id;
  const tail = String(id || '').replace(/^tpl_/, '').split('_').pop();
  if (!tail || tail.length < 4) return null;
  const hits = Object.keys(b).filter((k) => k.split('_').pop() === tail);
  return hits.length === 1 ? hits[0] : null;
}

export interface NpcLink {
  id: string;
  name: string;
  kind: 'template' | 'actor' | 'missing';
  folder: string;
}
export function npcInfo(game: GameView, id: string): NpcLink {
  const tid = resolveTemplateId(game, id);
  const tpl = tid ? game.bestiary?.[tid] : undefined;
  if (tid && tpl) return { id: tid, name: tpl.name || tid, kind: 'template', folder: tpl.folder || '' };
  const a = game.actors?.[id];
  if (a) return { id, name: a.name || id, kind: 'actor', folder: a.type === 'pc' ? t('PC') : t('NPCs in play') };
  return { id, name: prettyId(id), kind: 'missing', folder: '' };
}

export function mapInfo(game: GameView, id: string) {
  const m = game.maps?.[id];
  return m ? { id, name: m.name || id, exists: true, folder: m.folder || '' } : { id, name: prettyId(id), exists: false, folder: '' };
}

export interface LinkOption {
  id: string;
  name: string;
  folder: string;
}
export function templateOptions(game: GameView): LinkOption[] {
  return Object.entries(game.bestiary || {})
    .map(([id, tpl]) => ({ id, name: tpl?.name || id, folder: tpl?.folder || t('Miscellaneous') }))
    .sort((a, b) => compare(a.folder, b.folder) || compare(a.name, b.name));
}

export function mapOptions(game: GameView): LinkOption[] {
  return Object.entries(game.maps || {})
    .map(([id, m]) => ({ id, name: m?.name || id, folder: m?.folder || '' }))
    .sort((a, b) => compare(a.folder, b.folder) || compare(a.name, b.name));
}

/** Group options by folder into <optgroup>s. */
export function groupedOptions(list: LinkOption[]) {
  const groups = new Map<string, LinkOption[]>();
  for (const o of list) {
    const g = o.folder || t('Miscellaneous');
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(o);
  }
  return [...groups.entries()].map(([label, items]) => (
    <optgroup key={label} label={label}>
      {items.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </optgroup>
  ));
}

// ---------------------------------------------------------------------------
// Quick actions owned by other modules
// ---------------------------------------------------------------------------
export async function spawnNpc(game: GameView, linkedId: string, { hidden = false, count = 1 } = {}) {
  const templateId = resolveTemplateId(game, linkedId) || linkedId;
  const viewMapId = getUI().viewMapId;
  const mapId = (viewMapId && game.maps?.[viewMapId] ? viewMapId : null) || game.scene?.activeMapId || undefined;
  try {
    const res = await send<{ tokenIds?: string[] }>('bestiary/spawn', { templateId, mapId, count, hidden });
    const name = npcInfo(game, templateId).name;
    const placed = Array.isArray(res?.tokenIds) ? res.tokenIds.length : count;
    if (placed) {
      const map = mapId ? mapInfo(game, mapId).name : '';
      let msg;
      if (map) msg = hidden ? tn(placed, '{name} placed on the map “{map}” (hidden)', 'pl::{name} placed on the map “{map}” (hidden)', { name, map }) : tn(placed, '{name} placed on the map “{map}”', 'pl::{name} placed on the map “{map}”', { name, map });
      else msg = hidden ? tn(placed, '{name} placed on the map (hidden)', 'pl::{name} placed on the map (hidden)', { name }) : tn(placed, '{name} placed on the map', 'pl::{name} placed on the map', { name });
      toast(msg, 'success');
    } else toast(t("{name} created, but no map is displayed (or no free space left)", { name }), 'warn');
  } catch {}
}

export async function showMapToPlayers(game: GameView, mapId: string) {
  try {
    await send('maps/setActive', { mapId });
    toast(t('Map shown to players: {map}', { map: mapInfo(game, mapId).name }), 'success');
  } catch {}
}

/** Reveal a handout ('all' or [userId]) with a confirmation toast. */
export async function revealHandout(handoutId: string, to: 'all' | string[]) {
  try {
    const res = await send<{ notified?: string[] }>('campaign/revealHandout', { handoutId, to });
    const n = Array.isArray(res?.notified) ? res.notified.length : 0;
    toast(to === 'all' ? t('Handout revealed to all players') : n ? t('Handout sent') : t('That player already had it'), n || to === 'all' ? 'success' : 'info');
  } catch {}
}

export function openMap(mapId: string) {
  setUI({ viewMapId: mapId, mainTab: 'map' });
}

// ---------------------------------------------------------------------------
// Campaign documents (GM): cached list from GET /api/docs
// ---------------------------------------------------------------------------
type DocsListener = (v: { list: DocMeta[]; error: string | null }) => void;
let docsCache: Promise<DocMeta[]> | null = null;
const docsListeners = new Set<DocsListener>();
export function reloadDocs(): Promise<DocMeta[]> {
  docsCache = api<unknown>('/api/docs')
    .then((list) => (Array.isArray(list) ? (list as DocMeta[]) : []))
    .catch((err) => {
      docsCache = null;
      throw err;
    });
  const p = docsCache;
  p.then((list) => docsListeners.forEach((l) => l({ list, error: null }))).catch((err) => docsListeners.forEach((l) => l({ list: [], error: err.message || t('Error') })));
  return p;
}
export function useDocs(): DocsState {
  const [s, setS] = useState<DocsState>({ list: [], error: null, loading: true });
  useEffect(() => {
    let alive = true;
    const l: DocsListener = (v) => {
      if (alive) setS({ ...v, loading: false });
    };
    docsListeners.add(l);
    (docsCache || reloadDocs()).then((list) => l({ list, error: null })).catch((err) => l({ list: [], error: err.message || t('Error') }));
    return () => {
      alive = false;
      docsListeners.delete(l);
    };
  }, []);
  return s;
}

/** 'file.md#Heading' -> { name, anchor } */
export function parseDocRef(ref: string | null | undefined): { name: string; anchor: string } | null {
  if (!ref) return null;
  const i = ref.indexOf('#');
  return i < 0 ? { name: ref, anchor: '' } : { name: ref.slice(0, i), anchor: ref.slice(i + 1) };
}

export function docTitle(name: string | null | undefined): string {
  const base = String(name || '').replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : String(name ?? '');
}

/** Select of campaign docs (keeps the current value even if the file is gone). */
export function DocSelect({ value, onChange, docs }: { value: string | null | undefined; onChange: (name: string) => void; docs: DocMeta[] }) {
  const ref = parseDocRef(value);
  const name = ref?.name || '';
  const known = docs.some((d) => d.name === name);
  return (
    <select className="input camp-doc-select" value={name} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t('— No document —')}</option>
      {name && !known && <option value={name}>{t('{name} (not found)', { name })}</option>}
      {docs.map((d) => (
        <option key={d.name} value={d.name}>
          {docTitle(d.name)}
        </option>
      ))}
    </select>
  );
}

/** Button that opens a doc reference in the Documents tab. */
export function DocButton({ docRef, nav, small = true, label }: { docRef: string | null | undefined; nav: CampaignNav; small?: boolean; label?: ReactNode }) {
  const r = parseDocRef(docRef);
  if (!r || !docRef) return null;
  return (
    <button
      className={cx('btn btn-ghost camp-doc-btn', small && 'btn-sm')}
      title={t('Open {doc}', { doc: docRef })}
      onClick={(e) => {
        e.stopPropagation();
        nav.openDoc(docRef);
      }}
    >
      <span className="camp-ico">❐</span> {label || docTitle(r.name)}
      {r.anchor ? <span className="faint"> › {r.anchor}</span> : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Markdown editor: write / preview / side by side. Commits on blur, Ctrl+S, or unmount.
// ---------------------------------------------------------------------------
type MdMode = 'preview' | 'edit' | 'split';
interface MdEditorProps {
  value: string | null | undefined;
  onSave?: (text: string) => unknown;
  rows?: number;
  placeholder?: string;
  initialMode?: MdMode;
  emptyText?: ReactNode;
  label?: ReactNode;
  className?: string;
  tall?: boolean;
}
export function MdEditor({ value, onSave, rows = 8, placeholder = '', initialMode = 'preview', emptyText, label, className, tall }: MdEditorProps) {
  const [mode, setMode] = useState<MdMode>(initialMode);
  const [draft, setDraft] = useState(value || '');
  const [dirty, setDirty] = useState(false);
  const r = useRef<{ draft: string; dirty: boolean; value: string; onSave?: (text: string) => unknown }>({ draft: '', dirty: false, value: '' });
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
  useEffect(
    () => () => {
      if (r.current.dirty && r.current.draft !== r.current.value) r.current.onSave?.(r.current.draft);
    },
    []
  );

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'Enter')) {
      e.preventDefault();
      commit();
    }
    if (e.key === 'Tab' && !e.shiftKey && ta.selectionStart === ta.selectionEnd) {
      // Insert two spaces instead of leaving the field (lists indentation).
      e.preventDefault();
      const s = ta.selectionStart;
      const next = ta.value.slice(0, s) + '  ' + ta.value.slice(s);
      setDraft(next);
      setDirty(true);
      requestAnimationFrame(() => ta.setSelectionRange(s + 2, s + 2));
    }
  };

  const textarea = (
    <textarea
      key="ta"
      className="input camp-md-input"
      rows={rows}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => {
        setDraft(e.target.value);
        setDirty(true);
      }}
      onBlur={commit}
      onKeyDown={onKeyDown}
    ></textarea>
  );
  const preview = draft.trim() ? (
    <Markdown key="pv" className="camp-md-preview" text={draft} />
  ) : (
    <div key="pv" className="camp-md-preview camp-md-empty" onDoubleClick={() => setMode('edit')}>
      {emptyText ?? t('Empty — click “Write” to start writing.')}
    </div>
  );

  const modes: Array<{ id: MdMode; label: string }> = [
    { id: 'preview', label: t('Preview') },
    { id: 'edit', label: t('Write') },
    { id: 'split', label: t('Side by side') },
  ];
  return (
    <div className={cx('camp-md', `camp-md-${mode}`, tall && 'camp-md-tall', className)}>
      <div className="camp-md-bar">
        {label && <span className="camp-md-label">{label}</span>}
        <span className="grow"></span>
        {dirty ? (
          <button className="camp-md-save" title={t('Save (Ctrl+S)')} onMouseDown={(e) => e.preventDefault()} onClick={commit}>
            ● {t('Save')}
          </button>
        ) : null}
        <div className="camp-seg">
          {modes.map((m) => (
            <button
              key={m.id}
              className={cx(m.id === mode && 'active', m.id === 'split' && 'camp-seg-wide')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                commit();
                setMode(m.id);
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <div className="camp-md-body" onDoubleClick={mode === 'preview' ? () => setMode('edit') : undefined}>
        {mode === 'preview' ? preview : mode === 'edit' ? textarea : [textarea, preview]}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
export function fmtDate(ts: number | string | null | undefined, withTime = true): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(locale(), withTime ? { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'long', year: 'numeric' });
}

export function fmtSessionDate(s: string | null | undefined): string {
  if (!s) return '';
  const d = new Date(s + (s.length === 10 ? 'T12:00:00' : ''));
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
}

// ---------------------------------------------------------------------------
// Handout card (player dossier look) — used by DossiersPage and the GM preview.
// ---------------------------------------------------------------------------
interface HandoutCardProps {
  handout: HandoutLike;
  unread?: boolean;
  open?: boolean;
  onToggle?: () => void;
  stamp?: ReactNode;
}
export function HandoutCard({ handout, unread, open = true, onToggle, stamp }: HandoutCardProps) {
  const [zoom, setZoom] = useState(false);
  const h = handout;
  return (
    <article className={cx('dos-card', unread && 'unread', open && 'open')}>
      <header className="dos-card-head" onClick={onToggle} role={onToggle ? 'button' : undefined}>
        <span className="dos-tab"></span>
        <div className="grow">
          <div className="dos-card-meta">
            <span className="dos-stamp">{stamp ?? t('Confidential')}</span>
            {h.revealedAt && <span className="faint small">{t('received {date}', { date: fmtDate(h.revealedAt) })}</span>}
            {unread && <Badge color="magenta">{t('New')}</Badge>}
          </div>
          <h3 className="dos-card-title">{h.title}</h3>
        </div>
        {onToggle && <span className={cx('camp-chev', open && 'open')}>›</span>}
      </header>
      {open && (
        <div className="dos-card-body">
          {h.image && (
            <button className="dos-img" title={t('Enlarge')} onClick={() => setZoom(true)}>
              <img src={h.image} alt={h.title} loading="lazy" />
            </button>
          )}
          {h.body ? <Markdown className="dos-md" text={h.body} /> : !h.image && <div className="faint small">{t('Empty document.')}</div>}
        </div>
      )}
      {zoom && (
        <Modal title={h.title} width={1200} onClose={() => setZoom(false)}>
          <img className="dos-zoom" src={h.image} alt={h.title} />
        </Modal>
      )}
    </article>
  );
}

/** Small inline confirm-free "remove" chip button. */
export function ChipX({ onClick, title }: { onClick: () => void; title?: string }) {
  return (
    <IconButton
      icon="✕"
      className="camp-chip-x"
      title={title || t('Remove')}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    />
  );
}
