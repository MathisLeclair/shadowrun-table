// « Notes » tab: private notes for each user, collaborative party notes (players + GM), notes shared with the GM.
// Two panes (list | editor); a single pane with a back button under 800 px. See ARCHITECTURE.md « Notes ».
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html, Button, IconButton, Badge, Empty, SearchBox, Toggle, loadCss, confirmAction } from '../../lib/ui.js';
import { send, useServerEvent } from '../../lib/net.js';
import { toast } from '../../lib/ui-store.js';
import { t, tn, tIfKnown, fmtDate, compare } from '../../lib/i18n.js';
import { NoteEditor } from './NoteEditor.js';
import { cx, isGM, userLabel, storedName, foreignLock, sortPages, excerpt, missingSelection, TRASH_MS } from './common.js';

loadCss('/modules/notes/notes.css');

const PENDING_MS = 3000; // how long a just-created page may take to reach our view

const SEL_KEY = (game) => `sr.notes.sel.${game.config?.table?.id || ''}.${game.me.id}`;
function loadSel(game) {
  try {
    return localStorage.getItem(SEL_KEY(game)) || null;
  } catch {
    return null;
  }
}
function storeSel(game, id) {
  try {
    if (id) localStorage.setItem(SEL_KEY(game), id);
    else localStorage.removeItem(SEL_KEY(game));
  } catch {}
}

export default function NotesPage({ game }) {
  const gm = isGM(game);
  const notes = game.notes || { pages: {}, comments: {}, settings: {} };
  const all = useMemo(() => Object.values(notes.pages || {}), [notes.pages]);
  // Server clock − browser clock, refreshed with every state sync (locks carry server timestamps).
  const skew = useMemo(() => (notes.now ? notes.now - Date.now() : 0), [notes.now]);
  const [selId, setSelIdRaw] = useState(() => loadSel(game));
  const [fresh, setFresh] = useState(null); // id of a page just created (title selected for typing)
  const [q, setQ] = useState('');
  const [view, setView] = useState('pages'); // pages | trash
  const [busy, setBusy] = useState(false);

  const setSel = (id) => {
    setSelIdRaw(id);
    storeSel(game, id);
  };
  const selected = selId ? notes.pages?.[selId] || null : null;

  // A page we just created: the action reply arrives before the state broadcast (30 ms later), so it is not in
  // `notes.pages` yet. Keep it selected while we wait for it (at most PENDING_MS).
  const pendingSel = useRef(null); // { id, until }
  const [pendingCheck, setPendingCheck] = useState(0);

  // The selected page vanished (unshared, purged…): back to the list.
  useEffect(() => {
    const what = missingSelection(selId, !!selected, pendingSel.current);
    if (what === 'keep') {
      if (selected && pendingSel.current?.id === selId) pendingSel.current = null;
      return;
    }
    if (what.wait) {
      const tm = setTimeout(() => setPendingCheck((n) => n + 1), what.wait + 10);
      return () => clearTimeout(tm);
    }
    pendingSel.current = null;
    setSel(null);
  }, [selId, !!selected, pendingCheck]);

  useServerEvent('notes:comment', (d) => d?.title && toast(t('{author} a commenté « {title} »', { author: tIfKnown(d.author), title: d.title }), 'info', 4500), []);

  const canCreateParty = !gm || !!notes.settings?.gmCanEditParty;

  async function create(scope, title) {
    if (busy) return null;
    setBusy(true);
    try {
      const r = await send('notes/create', { scope, title: title || t('Nouvelle note') });
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

  async function createLinked(title, scope) {
    const target = scope === 'party' && canCreateParty ? 'party' : 'private';
    const msg = target === 'party' ? t('Créer la note de groupe « {title} » ?', { title }) : t('Créer la note personnelle « {title} » ?', { title });
    if (await confirmAction(msg)) create(target, title);
  }

  const live = all.filter((p) => !p.deleted);
  const trash = all.filter((p) => p.deleted);
  const needle = q.trim().toLowerCase();
  const match = (p) => !needle || p.title.toLowerCase().includes(needle) || (p.folder || '').toLowerCase().includes(needle) || p.body.toLowerCase().includes(needle);
  const mine = sortPages(live.filter((p) => p.scope === 'private' && p.ownerId === game.me.id && match(p)));
  const party = sortPages(live.filter((p) => p.scope === 'party' && match(p)));
  const shared = gm ? live.filter((p) => p.scope === 'private' && p.ownerId !== game.me.id && p.shareWithGM && match(p)) : [];

  const item = (p) => {
    const lock = foreignLock(game, p, skew);
    const nComments = (notes.comments?.[p.id] || []).length;
    return html`<button key=${p.id} class=${cx('notes-item', p.id === selId && 'active')} onClick=${() => (setFresh(null), setSel(p.id))}>
      <span class="notes-item-title">
        ${p.pinned && html`<span class="notes-star" title=${t('Épinglée')}>★</span>`}
        <span class="grow">${p.title || t('Sans titre')}</span>
        ${p.scope === 'private' && p.ownerId === game.me.id && p.shareWithGM && html`<span class="notes-ico" title=${t('Partagée avec le MJ')}>👁</span>`}
        ${lock && html`<span class="notes-ico notes-lock" title=${t('{name} est en train d’écrire…', { name: storedName(game, lock.userId, lock.name) })}>✎</span>`}
        ${nComments > 0 && html`<span class="notes-ico" title=${tn(nComments, '{n} commentaire', '{n} commentaires')}>💬${nComments}</span>`}
      </span>
      ${needle && html`<span class="notes-item-sub">${excerpt(p.body, needle)}</span>`}
    </button>`;
  };

  // Folder groups inside a section (pinned pages first, unfiled pages before folders).
  const grouped = (list) => {
    const pinned = list.filter((p) => p.pinned);
    const rest = list.filter((p) => !p.pinned);
    const loose = rest.filter((p) => !p.folder);
    const folders = [...new Set(rest.filter((p) => p.folder).map((p) => p.folder))].sort(compare);
    return html`${pinned.map(item)}${loose.map(item)}
      ${folders.map(
        (f) => html`<div class="notes-folder-group" key=${'f:' + f}>
          <div class="notes-folder-name">📁 ${f}</div>
          ${rest.filter((p) => p.folder === f).map(item)}
        </div>`
      )}`;
  };

  const section = (title, list, { scope, emptyText, add }) => html`<div class="notes-section">
    <div class="notes-section-head">
      <span>${title}</span>
      ${add && html`<${IconButton} icon="+" title=${scope === 'party' ? t('Nouvelle note de groupe') : t('Nouvelle note personnelle')} disabled=${busy} onClick=${() => create(scope)} />`}
    </div>
    ${list.length ? grouped(list) : html`<div class="notes-none small faint">${needle ? t('Aucun résultat') : emptyText}</div>`}
  </div>`;

  // GM: shared notes grouped by player.
  const sharedByOwner = useMemo(() => {
    const m = new Map();
    for (const p of sortPages(shared)) {
      if (!m.has(p.ownerId)) m.set(p.ownerId, []);
      m.get(p.ownerId).push(p);
    }
    return [...m.entries()];
  }, [shared.map((p) => p.id + p.title + (p.pinned ? 1 : 0)).join('|')]);

  const sidebar = html`<aside class="notes-side">
    <div class="notes-side-top">
      <${SearchBox} value=${q} onChange=${setQ} placeholder=${t('Chercher dans les notes…')} />
    </div>
    ${view === 'trash'
      ? html`<${Trash} game=${game} pages=${trash} onBack=${() => setView('pages')} onOpen=${setSel} selId=${selId} />`
      : html`<div class="notes-side-scroll">
          ${section(t('Mes notes'), mine, { scope: 'private', add: true, emptyText: gm ? t('Tes notes privées de MJ.') : t('Tes notes privées : personne d’autre ne les voit, pas même le MJ, sauf si tu les partages avec lui. Seules les sauvegardes du serveur (gérées par l’hébergeur) les contiennent.') })}
          ${section(t('Notes du groupe'), party, { scope: 'party', add: canCreateParty, emptyText: t('Notes communes : tout le groupe et le MJ les lisent.') })}
          ${gm &&
          html`<div class="notes-section">
            <div class="notes-section-head"><span>${t('Notes partagées par les joueurs')}</span></div>
            ${sharedByOwner.length
              ? sharedByOwner.map(
                  ([owner, list]) => html`<div class="notes-folder-group" key=${'o:' + owner}>
                    <div class="notes-folder-name">👤 ${userLabel(game, owner)}</div>
                    ${list.map(item)}
                  </div>`
                )
              : html`<div class="notes-none small faint">${needle ? t('Aucun résultat') : t('Aucune note partagée pour l’instant.')}</div>`}
          </div>`}
        </div>`}
    <div class="notes-side-foot">
      ${view === 'pages' &&
      html`<${Button} small variant="ghost" onClick=${() => setView('trash')}>🗑 ${t('Corbeille')}${trash.length ? ` (${trash.length})` : ''}</${Button}>`}
      ${gm &&
      html`<${Toggle} value=${!!notes.settings?.gmCanEditParty} onChange=${(v) => send('notes/settings', { gmCanEditParty: v })}
        label=${t('Le MJ peut modifier les notes du groupe')} />`}
    </div>
  </aside>`;

  return html`<div class=${cx('notes-root', selected && 'has-sel')}>
    ${sidebar}
    <section class="notes-main">
      ${selected
        ? html`<${NoteEditor} key=${selected.id} game=${game} page=${selected} pages=${all} skew=${skew} fresh=${fresh === selected.id}
            onOpen=${(id) => (setFresh(null), setSel(id))} onCreateLinked=${createLinked} onBack=${() => setSel(null)} onDeleted=${() => setSel(null)} />`
        : html`<div class="notes-welcome">
            <h2 class="page-title">${t('Notes')}</h2>
            <${Empty}>${t('Choisis une note à gauche ou crée-en une.')}</${Empty}>
            <div class="row wrap" style=${{ justifyContent: 'center' }}>
              <${Button} variant="primary" disabled=${busy} onClick=${() => create('private')}>${t('Nouvelle note personnelle')}</${Button}>
              ${canCreateParty && html`<${Button} disabled=${busy} onClick=${() => create('party')}>${t('Nouvelle note de groupe')}</${Button}>`}
            </div>
          </div>`}
    </section>
  </div>`;
}

function Trash({ game, pages, onBack, onOpen, selId }) {
  const gm = isGM(game);
  const list = [...pages].sort((a, b) => (b.deleted?.at || 0) - (a.deleted?.at || 0));
  const canPurge = (p) => (p.scope === 'private' ? p.ownerId === game.me.id : gm || p.createdBy === game.me.id);
  const canRestore = (p) => p.scope === 'party' || p.ownerId === game.me.id;
  return html`<div class="notes-side-scroll">
    <div class="notes-section">
      <div class="notes-section-head">
        <${IconButton} icon="←" title=${t('Retour aux notes')} onClick=${onBack} />
        <span class="grow">${t('Corbeille')}</span>
      </div>
      <div class="small faint notes-none">${t('Les notes supprimées restent ici 7 jours, puis disparaissent.')}</div>
      ${list.length
        ? list.map((p) => {
            const days = Math.max(0, Math.ceil((p.deleted.at + TRASH_MS - Date.now()) / 86400000));
            return html`<div key=${p.id} class=${cx('notes-trash-item', p.id === selId && 'active')}>
              <button class="notes-item" onClick=${() => onOpen(p.id)}>
                <span class="notes-item-title"><span class="grow">${p.title || t('Sans titre')}</span>
                  <${Badge} color=${p.scope === 'party' ? 'cyan' : 'dim'}>${p.scope === 'party' ? t('notes::Groupe') : t('Personnelle')}</${Badge}></span>
                <span class="notes-item-sub">${t('Supprimée par {name} le {date}', { name: userLabel(game, p.deleted.by), date: fmtDate(p.deleted.at) })} · ${tn(days, 'encore {n} jour', 'encore {n} jours')}</span>
              </button>
              <div class="row gap-s">
                ${canRestore(p) && html`<${Button} small onClick=${() => send('notes/restore', { id: p.id })}>${t('Restaurer')}</${Button}>`}
                ${canPurge(p) &&
                html`<${Button} small variant="danger"
                  onClick=${async () => (await confirmAction(t('Supprimer définitivement « {title} » ? Impossible de revenir en arrière.', { title: p.title }))) && send('notes/purge', { id: p.id })}>
                  ${t('Supprimer définitivement')}</${Button}>`}
              </div>
            </div>`;
          })
        : html`<${Empty}>${t('La corbeille est vide.')}</${Empty}>`}
    </div>
  </div>`;
}
