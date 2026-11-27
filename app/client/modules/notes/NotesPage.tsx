// « Notes » tab: private notes for each user, collaborative party notes (players + GM), notes shared with the GM.
// Two panes (list | editor); a single pane with a back button under 800 px. See ARCHITECTURE.md « Notes ».
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, IconButton, Badge, Empty, SearchBox, Toggle, confirmAction } from '../../lib/ui.tsx';
import { send, useServerEvent, type GameProps } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t, tn, tIfKnown, fmtDate, compare } from '../../lib/i18n.ts';
import { NoteEditor } from './NoteEditor.tsx';
import { cx, isGM, userLabel, storedName, foreignLock, sortPages, excerpt, missingSelection, TRASH_MS } from './common.ts';
import type { GameView, NotePage, NotesView } from '../../../shared/types.ts';
import './notes.css';

const PENDING_MS = 3000; // how long a just-created page may take to reach our view

type Scope = NotePage['scope'];

const SEL_KEY = (game: GameView) => `sr.notes.sel.${game.config?.table?.id || ''}.${game.me.id}`;
function loadSel(game: GameView): string | null {
  try {
    return localStorage.getItem(SEL_KEY(game)) || null;
  } catch {
    return null;
  }
}
function storeSel(game: GameView, id: string | null) {
  try {
    if (id) localStorage.setItem(SEL_KEY(game), id);
    else localStorage.removeItem(SEL_KEY(game));
  } catch {}
}

export default function NotesPage({ game }: GameProps) {
  const gm = isGM(game);
  const notes: Partial<NotesView> & Pick<NotesView, 'pages' | 'comments' | 'settings'> = game.notes || { pages: {}, comments: {}, settings: { gmCanEditParty: false } };
  const all = useMemo(() => Object.values(notes.pages || {}), [notes.pages]);
  // Server clock − browser clock, refreshed with every state sync (locks carry server timestamps).
  const skew = useMemo(() => (notes.now ? notes.now - Date.now() : 0), [notes.now]);
  const [selId, setSelIdRaw] = useState<string | null>(() => loadSel(game));
  const [fresh, setFresh] = useState<string | null>(null); // id of a page just created (title selected for typing)
  const [q, setQ] = useState('');
  const [view, setView] = useState<'pages' | 'trash'>('pages'); // pages | trash
  const [busy, setBusy] = useState(false);

  const setSel = (id: string | null) => {
    setSelIdRaw(id);
    storeSel(game, id);
  };
  const selected = selId ? notes.pages?.[selId] || null : null;

  // A page we just created: the action reply arrives before the state broadcast (30 ms later), so it is not in
  // `notes.pages` yet. Keep it selected while we wait for it (at most PENDING_MS).
  const pendingSel = useRef<{ id: string; until: number } | null>(null); // { id, until }
  const [pendingCheck, setPendingCheck] = useState(0);

  // The selected page vanished (unshared, purged…): back to the list.
  useEffect(() => {
    const what = missingSelection(selId, !!selected, pendingSel.current);
    if (what === 'keep') {
      if (selected && pendingSel.current?.id === selId) pendingSel.current = null;
      return;
    }
    if (typeof what === 'object' && what.wait) {
      const tm = setTimeout(() => setPendingCheck((n) => n + 1), what.wait + 10);
      return () => clearTimeout(tm);
    }
    pendingSel.current = null;
    setSel(null);
  }, [selId, !!selected, pendingCheck]);

  useServerEvent(
    'notes:comment',
    (d: { author?: string; title?: string } | null) => d?.title && toast(t('{author} a commenté « {title} »', { author: tIfKnown(d.author), title: d.title }), 'info', 4500),
    []
  );

  const canCreateParty = !gm || !!notes.settings?.gmCanEditParty;

  async function create(scope: Scope, title?: string) {
    if (busy) return null;
    setBusy(true);
    try {
      const r = await send<{ id: string }>('notes/create', { scope, title: title || t('Nouvelle note') });
      setView('pages');
      setFresh(title ? null : r.id);
      pendingSel.current = { id: r.id, until: Date.now() + PENDING_MS };
      setSel(r.id);
      return r.id;
    } catch {
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function createLinked(title: string, scope: Scope) {
    const target = scope === 'party' && canCreateParty ? 'party' : 'private';
    const msg = target === 'party' ? t('Créer la note de groupe « {title} » ?', { title }) : t('Créer la note personnelle « {title} » ?', { title });
    if (await confirmAction(msg)) create(target, title);
  }

  const live = all.filter((p) => !p.deleted);
  const trash = all.filter((p) => p.deleted);
  const needle = q.trim().toLowerCase();
  const match = (p: NotePage) => !needle || p.title.toLowerCase().includes(needle) || (p.folder || '').toLowerCase().includes(needle) || p.body.toLowerCase().includes(needle);
  const mine: NotePage[] = sortPages(live.filter((p) => p.scope === 'private' && p.ownerId === game.me.id && match(p)));
  const party: NotePage[] = sortPages(live.filter((p) => p.scope === 'party' && match(p)));
  const shared = gm ? live.filter((p) => p.scope === 'private' && p.ownerId !== game.me.id && p.shareWithGM && match(p)) : [];

  const item = (p: NotePage) => {
    const lock = foreignLock(game, p, skew);
    const nComments = (notes.comments?.[p.id] || []).length;
    return (
      <button
        key={p.id}
        className={cx('notes-item', p.id === selId && 'active')}
        onClick={() => {
          setFresh(null);
          setSel(p.id);
        }}
      >
        <span className="notes-item-title">
          {p.pinned && (
            <span className="notes-star" title={t('Épinglée')}>
              ★
            </span>
          )}
          <span className="grow">{p.title || t('Sans titre')}</span>
          {p.scope === 'private' && p.ownerId === game.me.id && p.shareWithGM && (
            <span className="notes-ico" title={t('Partagée avec le MJ')}>
              👁
            </span>
          )}
          {lock && (
            <span className="notes-ico notes-lock" title={t('{name} est en train d’écrire…', { name: storedName(game, lock.userId, lock.name) })}>
              ✎
            </span>
          )}
          {nComments > 0 && (
            <span className="notes-ico" title={tn(nComments, '{n} commentaire', '{n} commentaires')}>
              💬{nComments}
            </span>
          )}
        </span>
        {needle && <span className="notes-item-sub">{excerpt(p.body, needle)}</span>}
      </button>
    );
  };

  // Folder groups inside a section (pinned pages first, unfiled pages before folders).
  const grouped = (list: NotePage[]) => {
    const pinned = list.filter((p) => p.pinned);
    const rest = list.filter((p) => !p.pinned);
    const loose = rest.filter((p) => !p.folder);
    const folders = [...new Set(rest.filter((p) => p.folder).map((p) => p.folder))].sort(compare);
    return (
      <>
        {pinned.map(item)}
        {loose.map(item)}
        {folders.map((f) => (
          <div className="notes-folder-group" key={'f:' + f}>
            <div className="notes-folder-name">📁 {f}</div>
            {rest.filter((p) => p.folder === f).map(item)}
          </div>
        ))}
      </>
    );
  };

  const section = (title: string, list: NotePage[], { scope, emptyText, add }: { scope: Scope; emptyText: string; add?: boolean }) => (
    <div className="notes-section">
      <div className="notes-section-head">
        <span>{title}</span>
        {add && <IconButton icon="+" title={scope === 'party' ? t('Nouvelle note de groupe') : t('Nouvelle note personnelle')} disabled={busy} onClick={() => create(scope)} />}
      </div>
      {list.length ? grouped(list) : <div className="notes-none small faint">{needle ? t('Aucun résultat') : emptyText}</div>}
    </div>
  );

  // GM: shared notes grouped by player.
  const sharedByOwner = useMemo(() => {
    const m = new Map<string, NotePage[]>();
    for (const p of sortPages(shared) as NotePage[]) {
      const owner = p.ownerId || '';
      if (!m.has(owner)) m.set(owner, []);
      m.get(owner)!.push(p);
    }
    return [...m.entries()];
  }, [shared.map((p) => p.id + p.title + (p.pinned ? 1 : 0)).join('|')]);

  const sidebar = (
    <aside className="notes-side">
      <div className="notes-side-top">
        <SearchBox value={q} onChange={setQ} placeholder={t('Chercher dans les notes…')} />
      </div>
      {view === 'trash' ? (
        <Trash game={game} pages={trash} onBack={() => setView('pages')} onOpen={setSel} selId={selId} />
      ) : (
        <div className="notes-side-scroll">
          {section(t('Mes notes'), mine, {
            scope: 'private',
            add: true,
            emptyText: gm
              ? t('Tes notes privées de MJ.')
              : t('Tes notes privées : personne d’autre ne les voit, pas même le MJ, sauf si tu les partages avec lui. Seules les sauvegardes du serveur (gérées par l’hébergeur) les contiennent.'),
          })}
          {section(t('Notes du groupe'), party, { scope: 'party', add: canCreateParty, emptyText: t('Notes communes : tout le groupe et le MJ les lisent.') })}
          {gm && (
            <div className="notes-section">
              <div className="notes-section-head">
                <span>{t('Notes partagées par les joueurs')}</span>
              </div>
              {sharedByOwner.length ? (
                sharedByOwner.map(([owner, list]) => (
                  <div className="notes-folder-group" key={'o:' + owner}>
                    <div className="notes-folder-name">👤 {userLabel(game, owner)}</div>
                    {list.map(item)}
                  </div>
                ))
              ) : (
                <div className="notes-none small faint">{needle ? t('Aucun résultat') : t('Aucune note partagée pour l’instant.')}</div>
              )}
            </div>
          )}
        </div>
      )}
      <div className="notes-side-foot">
        {view === 'pages' && (
          <Button small variant="ghost" onClick={() => setView('trash')}>
            🗑 {t('Corbeille')}
            {trash.length ? ` (${trash.length})` : ''}
          </Button>
        )}
        {gm && (
          <Toggle value={!!notes.settings?.gmCanEditParty} onChange={(v) => send('notes/settings', { gmCanEditParty: v })} label={t('Le MJ peut modifier les notes du groupe')} />
        )}
      </div>
    </aside>
  );

  return (
    <div className={cx('notes-root', selected && 'has-sel')}>
      {sidebar}
      <section className="notes-main">
        {selected ? (
          <NoteEditor
            key={selected.id}
            game={game}
            page={selected}
            pages={all}
            skew={skew}
            fresh={fresh === selected.id}
            onOpen={(id) => {
              setFresh(null);
              setSel(id);
            }}
            onCreateLinked={createLinked}
            onBack={() => setSel(null)}
            onDeleted={() => setSel(null)}
          />
        ) : (
          <div className="notes-welcome">
            <h2 className="page-title">{t('Notes')}</h2>
            <Empty>{t('Choisis une note à gauche ou crée-en une.')}</Empty>
            <div className="row wrap" style={{ justifyContent: 'center' }}>
              <Button variant="primary" disabled={busy} onClick={() => create('private')}>
                {t('Nouvelle note personnelle')}
              </Button>
              {canCreateParty && (
                <Button disabled={busy} onClick={() => create('party')}>
                  {t('Nouvelle note de groupe')}
                </Button>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

interface TrashProps {
  game: GameView;
  pages: NotePage[];
  onBack: () => void;
  onOpen: (id: string) => void;
  selId: string | null;
}
function Trash({ game, pages, onBack, onOpen, selId }: TrashProps) {
  const gm = isGM(game);
  const list = [...pages].sort((a, b) => (b.deleted?.at || 0) - (a.deleted?.at || 0));
  const canPurge = (p: NotePage) => (p.scope === 'private' ? p.ownerId === game.me.id : gm || p.createdBy === game.me.id);
  const canRestore = (p: NotePage) => p.scope === 'party' || p.ownerId === game.me.id;
  return (
    <div className="notes-side-scroll">
      <div className="notes-section">
        <div className="notes-section-head">
          <IconButton icon="←" title={t('Retour aux notes')} onClick={onBack} />
          <span className="grow">{t('Corbeille')}</span>
        </div>
        <div className="small faint notes-none">{t('Les notes supprimées restent ici 7 jours, puis disparaissent.')}</div>
        {list.length ? (
          list.map((p) => {
            const deleted = p.deleted!;
            const days = Math.max(0, Math.ceil((deleted.at + TRASH_MS - Date.now()) / 86400000));
            return (
              <div key={p.id} className={cx('notes-trash-item', p.id === selId && 'active')}>
                <button className="notes-item" onClick={() => onOpen(p.id)}>
                  <span className="notes-item-title">
                    <span className="grow">{p.title || t('Sans titre')}</span>
                    <Badge color={p.scope === 'party' ? 'cyan' : 'dim'}>{p.scope === 'party' ? t('notes::Groupe') : t('Personnelle')}</Badge>
                  </span>
                  <span className="notes-item-sub">
                    {t('Supprimée par {name} le {date}', { name: userLabel(game, deleted.by), date: fmtDate(deleted.at) })} · {tn(days, 'encore {n} jour', 'encore {n} jours')}
                  </span>
                </button>
                <div className="row gap-s">
                  {canRestore(p) && (
                    <Button small onClick={() => send('notes/restore', { id: p.id })}>
                      {t('Restaurer')}
                    </Button>
                  )}
                  {canPurge(p) && (
                    <Button
                      small
                      variant="danger"
                      onClick={async () => {
                        if (await confirmAction(t('Supprimer définitivement « {title} » ? Impossible de revenir en arrière.', { title: p.title }))) send('notes/purge', { id: p.id });
                      }}
                    >
                      {t('Supprimer définitivement')}
                    </Button>
                  )}
                </div>
              </div>
            );
          })
        ) : (
          <Empty>{t('La corbeille est vide.')}</Empty>
        )}
      </div>
    </div>
  );
}
