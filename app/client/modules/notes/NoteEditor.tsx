// One note: title, markdown editor (toolbar, preview), autosave with version check, soft lock, sharing, comments.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Button, IconButton, Badge, Toggle, Modal, TextInput, confirmAction } from '../../lib/ui.tsx';
import { send, type ServerError } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t, fmtDate } from '../../lib/i18n.ts';
import { renderNote, toggleCheckboxAt, applyFormat, decodeRef } from './notes-md.ts';
import { cx, canWrite, canComment, userLabel, storedName, mentionNames, foreignLock, findByTitle, copyText, errorGate, MAX_BODY, isGM } from './common.ts';
import { NoteComments } from './NoteComments.tsx';
import type { GameView, NotePage } from '../../../shared/types.ts';


const SAVE_DELAY = 1500;
const RENEW_MS = 20_000;
const IDLE_MS = 45_000;

type FormatKind = 'bold' | 'italic' | 'heading' | 'list' | 'check' | 'quote' | 'link';
type EditorMode = 'edit' | 'split' | 'preview';
type SaveStatus = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';
/** Server copy returned by notes/save on a version conflict. */
type ServerCopy = Pick<NotePage, 'title' | 'body' | 'version' | 'updatedBy' | 'updatedAt'>;

const TOOLS: Array<{ kind: FormatKind; icon: string; cls?: string }> = [
  { kind: 'bold', icon: 'B', cls: 'b' },
  { kind: 'italic', icon: 'I', cls: 'i' },
  { kind: 'heading', icon: 'H' },
  { kind: 'list', icon: '•' },
  { kind: 'check', icon: '☐' },
  { kind: 'quote', icon: '❝' },
  { kind: 'link', icon: '[[ ]]' },
];
const toolTitle = (k: FormatKind): string =>
  ({
    bold: t('Gras (Ctrl+B)'),
    italic: t('Italique (Ctrl+I)'),
    heading: t('Titre de section'),
    list: t('Liste à puces'),
    check: t('Case à cocher'),
    quote: t('Citation'),
    link: t('Lien vers une note : [[Titre de la note]]'),
  })[k];

interface NoteEditorProps {
  game: GameView;
  page: NotePage;
  pages: NotePage[];
  skew: number;
  fresh: boolean;
  onOpen: (id: string) => void;
  onCreateLinked: (title: string, scope: NotePage['scope']) => void;
  onBack: () => void;
  onDeleted?: () => void;
}

export function NoteEditor({ game, page, pages, skew, fresh, onOpen, onCreateLinked, onBack, onDeleted }: NoteEditorProps) {
  const writable = canWrite(game, page);
  const gm = isGM(game);
  const party = page.scope === 'party';
  const mine = page.scope === 'private' && page.ownerId === game.me.id;

  const [title, setTitle] = useState(page.title);
  const [body, setBody] = useState(page.body);
  const [status, setStatus] = useState<SaveStatus>('saved'); // saved | dirty | saving | conflict | error
  const [conflict, setConflict] = useState<ServerCopy | null>(null); // server copy { title, body, version, updatedBy, updatedAt }
  const [mode, setMode] = useState<EditorMode>(() => (writable && (fresh || !page.body) ? 'edit' : writable ? readMode() : 'preview'));
  const [forced, setForced] = useState(false);
  const [, tick] = useState(0);

  const synced = useRef({ version: page.version, body: page.body, title: page.title });
  const bodyRef = useRef(page.body);
  const titleRef = useRef(page.title);
  const pageRef = useRef(page);
  pageRef.current = page;
  const gameRef = useRef(game);
  gameRef.current = game;
  const saving = useRef(false);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const conflictRef = useRef<ServerCopy | null>(null);
  conflictRef.current = conflict;
  const lock = useRef({ held: false, pending: false, lastInput: 0, forced: false, refusedAt: 0 });
  lock.current.forced = forced;
  const taRef = useRef<HTMLTextAreaElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);

  const foreign = party && writable ? foreignLock(game, page, skew) : null;
  const lockedOut = !!foreign && !forced;
  const lockName = foreign ? storedName(game, foreign.userId, foreign.name) : '';
  const readOnly = !writable || lockedOut;

  // Re-render while a foreign lock is displayed so it disappears when it expires.
  useEffect(() => {
    if (!foreign) return;
    const iv = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(iv);
  }, [!!foreign]);

  useEffect(() => {
    if (fresh && writable) setTimeout(() => titleInput.current?.select(), 30);
  }, []);

  // ---------------------------------------------------------------- server → local
  useEffect(() => {
    const s = synced.current;
    if (page.version !== s.version) {
      if (bodyRef.current === s.body) {
        // Nothing pending here: follow the server (live collaboration).
        bodyRef.current = page.body;
        setBody(page.body);
        synced.current = { ...s, version: page.version, body: page.body };
      } else if (bodyRef.current === page.body) {
        synced.current = { ...s, version: page.version, body: page.body }; // echo of our own save
      }
      // else: local edits on an old version → the next save reports the conflict.
    }
    if (page.title !== synced.current.title) {
      if (titleRef.current === synced.current.title && document.activeElement !== titleInput.current) {
        titleRef.current = page.title;
        setTitle(page.title);
      }
      synced.current = { ...synced.current, title: page.title };
    }
  }, [page.version, page.body, page.title]);

  // ---------------------------------------------------------------- saving
  const dirty = () => bodyRef.current !== synced.current.body || titleRef.current !== synced.current.title;

  function schedule(ms = SAVE_DELAY) {
    clearTimeout(timer.current);
    timer.current = setTimeout(saveNow, ms);
  }

  // A failing save is retried on every pause in typing: say why once per distinct error, not every 1.5 s.
  const errors = useMemo(errorGate, []);
  function saveFailed(message: string) {
    setStatus('error');
    if (errors.shouldToast(message)) toast(message, 'error');
  }

  // opts.restored: the page was just restored by us (the server agreed; our view of it may still say « trash »).
  async function saveNow(opts?: { restored?: boolean }) {
    clearTimeout(timer.current);
    if (conflictRef.current || (!opts?.restored && !canWrite(gameRef.current, pageRef.current))) return;
    if (saving.current) {
      again.current = true;
      return;
    }
    if (!dirty()) {
      setStatus('saved');
      return;
    }
    const sent = { body: bodyRef.current, title: titleRef.current };
    if (sent.body.length > MAX_BODY) {
      saveFailed(t('Note trop longue ({max} caractères maximum)', { max: MAX_BODY }));
      return;
    }
    saving.current = true;
    setStatus('saving');
    try {
      const res = await send<{ conflict?: boolean; server: ServerCopy; version: number }>(
        'notes/save',
        { id: pageRef.current.id, title: sent.title.trim() ? sent.title : undefined, body: sent.body, baseVersion: synced.current.version },
        { silent: true }
      );
      if (res?.conflict) {
        setConflict(res.server);
        setStatus('conflict');
        return;
      }
      synced.current = { version: res.version, body: sent.body, title: sent.title.trim() ? sent.title : synced.current.title };
      errors.reset();
      setStatus(dirty() ? 'dirty' : 'saved');
      if (dirty()) again.current = true;
    } catch (err) {
      saveFailed((err as Error).message);
    } finally {
      saving.current = false;
      if (again.current && !conflictRef.current) {
        again.current = false;
        schedule(300);
      }
    }
  }

  // ---------------------------------------------------------------- soft lock (party pages)
  async function takeLock(force = false) {
    const L = lock.current;
    if (!party || !canWrite(gameRef.current, pageRef.current) || L.pending) return;
    // After a refusal (someone else holds it) don't retry on every keystroke.
    if (!force && !L.forced && L.refusedAt && Date.now() - L.refusedAt < 5000) return;
    L.pending = true;
    try {
      const res = await send<{ locked?: unknown }>('notes/lock', { id: pageRef.current.id, force: force || L.forced }, { silent: true });
      L.held = !res?.locked;
      L.refusedAt = res?.locked ? Date.now() : 0;
    } catch {
      L.held = false;
    } finally {
      L.pending = false;
    }
  }
  function touched() {
    lock.current.lastInput = Date.now();
    if (!lock.current.held) takeLock();
  }

  useEffect(() => {
    if (!party) return;
    const iv = setInterval(() => {
      const L = lock.current;
      if (!L.held) return;
      if (Date.now() - L.lastInput < IDLE_MS) takeLock();
      else {
        L.held = false;
        send('notes/unlock', { id: pageRef.current.id }, { silent: true }).catch(() => {});
      }
    }, RENEW_MS);
    return () => clearInterval(iv);
  }, []);

  // Flush on leave (page switch, tab switch, language switch remount) and when the browser tab is hidden/closed.
  useEffect(() => {
    const flush = () => {
      if (dirty()) saveNow();
    };
    const vis = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', vis);
    return () => {
      removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', vis);
      // Edits that can no longer be saved (page trashed/purged by someone else, write right lost, open conflict): say so.
      if (dirty() && (conflictRef.current || !canWrite(gameRef.current, pageRef.current)))
        toast(t('Tes dernières modifications de « {title} » n’ont pas été enregistrées.', { title: titleRef.current || pageRef.current.title }), 'error', 8000);
      flush();
      if (lock.current.held) send('notes/unlock', { id: pageRef.current.id }, { silent: true }).catch(() => {});
    };
  }, []);

  // ---------------------------------------------------------------- editing
  function changeBody(v: string) {
    bodyRef.current = v;
    setBody(v);
    setStatus('dirty');
    touched();
    schedule();
  }
  function changeTitle(v: string) {
    titleRef.current = v;
    setTitle(v);
    setStatus('dirty');
    touched();
    schedule();
  }

  function format(kind: FormatKind) {
    const ta = taRef.current;
    if (!ta || readOnly) return;
    const r = applyFormat(bodyRef.current, ta.selectionStart, ta.selectionEnd, kind);
    changeBody(r.value);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(r.start, r.end);
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'b' || k === 'i') {
      e.preventDefault();
      format(k === 'b' ? 'bold' : 'italic');
    } else if (k === 's') {
      e.preventDefault();
      saveNow();
    }
  }

  async function forceEdit() {
    if (!(await confirmAction(t('{name} est en train d’écrire dans cette note. Modifier quand même ? Vos modifications pourraient entrer en conflit.', { name: lockName })))) return;
    setForced(true);
    lock.current.forced = true;
    lock.current.lastInput = Date.now();
    await takeLock(true);
    if (mode === 'preview') setMode('edit');
  }

  // ---------------------------------------------------------------- conflict
  function keepMine() {
    const cur = pageRef.current;
    const base = cur.version >= (conflict?.version || 0) ? cur : conflict!;
    synced.current = { version: base.version, body: base.body, title: base.title };
    setConflict(null);
    conflictRef.current = null;
    setStatus('dirty');
    setTimeout(saveNow, 0);
  }
  function takeTheirs() {
    const cur = pageRef.current;
    const base = cur.version >= (conflict?.version || 0) ? cur : conflict!;
    bodyRef.current = base.body;
    titleRef.current = base.title;
    setBody(base.body);
    setTitle(base.title);
    synced.current = { version: base.version, body: base.body, title: base.title };
    setConflict(null);
    conflictRef.current = null;
    setStatus('saved');
  }
  async function copyMine() {
    toast((await copyText(bodyRef.current)) ? t('Ta version est copiée dans le presse-papiers') : t('Copie impossible : sélectionne le texte à la main'), 'info');
  }

  // ---------------------------------------------------------------- preview
  const resolve = useMemo(() => {
    const live = pages.filter((p) => !p.deleted);
    return (tt: string) => findByTitle(live, tt, page.scope)?.id || null;
  }, [pages, page.scope]);
  const names = useMemo(() => mentionNames(game), [game.actors, game.users]);
  const showPreview = mode !== 'edit' || readOnly;
  const rendered = useMemo(() => (showPreview ? renderNote(body, { resolve, mentions: names, editable: !readOnly }) : null), [body, resolve, names, readOnly, showPreview]);

  function onPreviewClick(e: MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    const cb = target.closest?.('input.notes-cb') as HTMLInputElement | null;
    if (cb) {
      e.preventDefault();
      // data-line = the checkbox's own source line (absent when it could not be traced: not clickable).
      if (readOnly || cb.dataset.line === undefined) return;
      const next = toggleCheckboxAt(bodyRef.current, Number(cb.dataset.line));
      if (next === bodyRef.current) return;
      changeBody(next);
      schedule(400);
      return;
    }
    const a = target.closest?.('a');
    const href = a?.getAttribute('href') || '';
    if (href.startsWith('#note:')) {
      e.preventDefault();
      onOpen(href.slice(6));
    } else if (href.startsWith('#new:')) {
      e.preventDefault();
      onCreateLinked(decodeRef(href.slice(5)), page.scope);
    }
  }

  function pickMode(m: EditorMode) {
    setMode(m);
    rememberReadMode(m);
  }

  // ---------------------------------------------------------------- actions
  const folders = useMemo(() => [...new Set(pages.filter((p) => p.scope === page.scope && p.folder).map((p) => p.folder))].sort(), [pages, page.scope]);

  const LOCK_KEY = '{name} est en train d’écrire dans cette note';
  async function remove() {
    // Someone is typing in it: the server refuses unless forced, so ask with that in mind (their unsaved text is at stake).
    const confirmForce = (name: string) =>
      confirmAction(t('{name} est en train d’écrire dans cette note. La mettre à la corbeille quand même ? Ses dernières modifications pourraient être perdues.', { name }));
    let force = false;
    if (foreign) {
      if (!(await confirmForce(lockName))) return;
      force = true;
    } else if (!(await confirmAction(t('Mettre « {title} » à la corbeille ? Elle restera restaurable pendant 7 jours.', { title: page.title })))) return;
    clearTimeout(timer.current);
    if (dirty()) await saveNow();
    try {
      await send('notes/delete', { id: page.id, force }, { silent: true });
    } catch (e) {
      const err = e as ServerError;
      // The lock was taken after this screen was drawn: same question, then force.
      if (err.key !== LOCK_KEY || !(await confirmForce(String(err.params?.name || '')))) {
        if (err.key !== LOCK_KEY) toast(err.message, 'error');
        return;
      }
      try {
        await send('notes/delete', { id: page.id, force: true });
      } catch {
        return;
      }
    }
    onDeleted?.();
  }

  // The page went to the trash (someone else deleted it) while edits were still unsaved here.
  async function restoreAndSave() {
    try {
      await send('notes/restore', { id: page.id });
    } catch {
      return;
    }
    await saveNow({ restored: true });
  }

  const ownerName = page.scope === 'private' ? userLabel(game, page.ownerId) : null;
  const canRestore = page.scope === 'party' || page.ownerId === game.me.id;
  const unsavedInTrash = !!page.deleted && dirty();
  const statusText = {
    saved: t('Enregistré'),
    dirty: t('Modifié…'),
    saving: t('Enregistrement…'),
    conflict: t('Conflit'),
    error: t('Erreur d’enregistrement'),
  }[status];

  return (
    <div className={cx('notes-editor', `mode-${mode}`)}>
      <header className="notes-ed-head">
        <button className="icon-btn notes-back" title={t('Retour à la liste')} onClick={onBack}>
          ←
        </button>
        <input
          ref={titleInput}
          className="input notes-title"
          value={title}
          maxLength={120}
          readOnly={readOnly}
          placeholder={t('Titre de la note')}
          aria-label={t('Titre de la note')}
          onChange={(e) => changeTitle(e.target.value)}
          onBlur={() => saveNow()}
          onKeyDown={(e) => e.key === 'Enter' && taRef.current?.focus()}
        />
        {writable && (
          <span className={cx('notes-status', `st-${status}`)} title={status === 'error' && errors.last ? errors.last : t('Enregistrement automatique')}>
            {statusText}
          </span>
        )}
        {writable && (
          <IconButton
            icon={page.pinned ? '★' : '☆'}
            className={cx(page.pinned && 'notes-pinned')}
            title={page.pinned ? t('Désépingler') : t('Épingler en haut de la liste')}
            onClick={() => send('notes/rename', { id: page.id, pinned: !page.pinned })}
          />
        )}
        {!page.deleted && (mine || party) && <IconButton icon="🗑" title={t('Mettre à la corbeille')} onClick={remove} />}
      </header>

      <div className="notes-ed-meta small muted">
        {party ? (
          <Badge color="cyan">{t('notes::Groupe')}</Badge>
        ) : mine ? (
          <Badge color="dim">{t('Personnelle')}</Badge>
        ) : (
          <Badge color="magenta">{t('Partagée par {name}', { name: ownerName })}</Badge>
        )}
        {writable ? (
          <>
            {/* Commits on blur / Enter (the native « change » event of the Preact version). */}
            <TextInput
              className="notes-folder"
              list="notes-folders"
              value={page.folder || ''}
              maxLength={60}
              placeholder={t('Dossier')}
              aria-label={t('Dossier')}
              onChange={(v) => send('notes/rename', { id: page.id, folder: v })}
            />
            <datalist id="notes-folders">
              {folders.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </>
        ) : (
          page.folder && <span>📁 {page.folder}</span>
        )}
        <span className="grow"></span>
        <span title={fmtDate(page.createdAt)}>{t('Modifié par {name} · {date}', { name: userLabel(game, page.updatedBy), date: fmtDate(page.updatedAt) })}</span>
      </div>

      {mine && !page.deleted && (
        <div className="notes-share">
          <Toggle
            value={!!page.shareWithGM}
            onChange={(v) => send('notes/setShare', { id: page.id, shareWithGM: v })}
            title={t('Les sauvegardes du serveur contiennent toutes les notes. Si le MJ efface ton code PIN, tu en es averti dans le journal.')}
            label={page.shareWithGM ? t('Partagée avec le MJ (lecture seule pour lui)') : t('Privée : cachée aux joueurs et au MJ dans l’onglet Notes')}
          />
        </div>
      )}
      {!mine && page.scope === 'private' && <div className="notes-banner">{t('Note personnelle de {name}, partagée avec toi en lecture seule.', { name: ownerName })}</div>}
      {party && gm && !writable && !page.deleted && <div className="notes-banner">{t('Lecture seule : les notes du groupe appartiennent aux joueurs (option dans la liste des notes).')}</div>}
      {page.deleted &&
        (unsavedInTrash ? (
          <div className="notes-banner warn">
            <span className="grow">{t('Cette note a été mise à la corbeille pendant que tu écrivais : tes dernières modifications ne sont pas enregistrées.')}</span>
            {canRestore && (
              <Button small variant="primary" onClick={restoreAndSave}>
                {t('Restaurer et enregistrer')}
              </Button>
            )}
            <Button small variant="ghost" onClick={copyMine}>
              {t('Copier ma version')}
            </Button>
          </div>
        ) : (
          <div className="notes-banner warn">
            <span className="grow">{t('Cette note est dans la corbeille.')}</span>
            {canRestore && (
              <Button small onClick={() => send('notes/restore', { id: page.id })}>
                {t('Restaurer')}
              </Button>
            )}
          </div>
        ))}
      {foreign && (
        <div className={cx('notes-banner', 'lock', forced && 'warn')}>
          <span className="notes-typing">
            <i></i>
            <i></i>
            <i></i>
          </span>
          <span className="grow">{t('{name} est en train d’écrire…', { name: lockName })}</span>
          {lockedOut && (
            <Button small variant="ghost" onClick={forceEdit}>
              {t('Modifier quand même')}
            </Button>
          )}
        </div>
      )}

      <div className="notes-toolbar">
        {!readOnly &&
          TOOLS.map((tool) => (
            <button
              key={tool.kind}
              type="button"
              className={cx('notes-tool', tool.cls)}
              title={toolTitle(tool.kind)}
              disabled={mode === 'preview'}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => format(tool.kind)}
            >
              {tool.icon}
            </button>
          ))}
        <span className="grow"></span>
        <div className="notes-modes" role="group" aria-label={t('Affichage')}>
          {!readOnly && (
            <button className={cx(mode === 'edit' && 'active')} onClick={() => pickMode('edit')}>
              {t('Écrire')}
            </button>
          )}
          {!readOnly && (
            <button className={cx('notes-split-btn', mode === 'split' && 'active')} onClick={() => pickMode('split')}>
              {t('Côte à côte')}
            </button>
          )}
          <button className={cx(mode === 'preview' && 'active')} onClick={() => pickMode('preview')}>
            {t('Aperçu')}
          </button>
        </div>
      </div>

      <div className="notes-ed-body">
        {mode !== 'preview' && !readOnly && (
          <textarea
            ref={taRef}
            className="notes-text"
            value={body}
            spellCheck={true}
            placeholder={t('Écris ici… Markdown accepté : **gras**, *italique*, - liste, - [ ] tâche, [[Autre note]], @Jane')}
            onChange={(e) => changeBody(e.target.value)}
            onBlur={() => saveNow()}
            onKeyDown={onKeyDown}
            onFocus={() => party && touched()}
          ></textarea>
        )}
        {showPreview && (
          <div className="md notes-preview" onClick={onPreviewClick} dangerouslySetInnerHTML={{ __html: rendered?.html || `<p class="muted">${t('Note vide.')}</p>` }}></div>
        )}
      </div>

      {(canComment(game, page) || (game.notes?.comments?.[page.id] || []).length > 0) && <NoteComments game={game} page={page} />}

      {conflict && (
        <Modal title={t('Conflit de modification')} width={640} onClose={() => {}}>
          <p>{t('{name} a modifié cette note pendant que tu écrivais ({date}). Que veux-tu garder ?', { name: userLabel(game, conflict.updatedBy), date: fmtDate(conflict.updatedAt) })}</p>
          <div className="notes-conflict">
            <div>
              <div className="small muted">{t('Ta version')}</div>
              <pre>{bodyRef.current}</pre>
            </div>
            <div>
              <div className="small muted">{t('Version enregistrée')}</div>
              <pre>{conflict.body}</pre>
            </div>
          </div>
          <div className="row wrap" style={{ marginTop: '12px', justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={copyMine}>
              {t('Copier ma version')}
            </Button>
            <Button onClick={takeTheirs}>{t('Prendre la leur')}</Button>
            <Button variant="primary" onClick={keepMine}>
              {t('Garder la mienne')}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// Remember the display mode the user prefers (per browser).
function readMode(): EditorMode {
  try {
    const m = localStorage.getItem('sr.notes.mode');
    return m === 'preview' || m === 'split' ? m : 'edit';
  } catch {
    return 'edit';
  }
}
function rememberReadMode(m: EditorMode) {
  try {
    localStorage.setItem('sr.notes.mode', m);
  } catch {}
}
