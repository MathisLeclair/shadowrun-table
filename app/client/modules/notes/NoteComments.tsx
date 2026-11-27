// Comments under a party note (or a private note shared with the GM).
import { useState } from 'react';
import { Button, IconButton, confirmAction } from '../../lib/ui.tsx';
import { send } from '../../lib/net.ts';
import { t, tn, fmtDate } from '../../lib/i18n.ts';
import { cx, canComment, storedName, isGM } from './common.ts';
import type { GameView, NoteComment, NotePage } from '../../../shared/types.ts';

export function NoteComments({ game, page }: { game: GameView; page: NotePage }) {
  const list: NoteComment[] = game.notes?.comments?.[page.id] || [];
  const [open, setOpen] = useState(list.length > 0);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const allowed = canComment(game, page);

  async function post() {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true);
    try {
      await send('notes/comment', { id: page.id, text: v });
      setText('');
    } catch {
      // toast already shown by send()
    } finally {
      setBusy(false);
    }
  }

  const mayDelete = (c: NoteComment) => c.userId === game.me.id || isGM(game) || (page.scope === 'private' && page.ownerId === game.me.id);

  return (
    <section className={cx('notes-comments', open && 'open')}>
      <button className="notes-comments-head" onClick={() => setOpen(!open)} aria-expanded={open ? 'true' : 'false'}>
        <span>{open ? '▾' : '▸'}</span>
        <span>{list.length ? tn(list.length, '{n} comment', '{n} comments') : t('Comments')}</span>
      </button>
      {open && (
        <div className="notes-comments-body">
          {list.map((c) => (
            <div className={cx('notes-comment', c.userId === game.me.id && 'mine', c.userId === 'gm' && 'gm')} key={c.id}>
              <div className="row small">
                <strong>{storedName(game, c.userId, c.author)}</strong>
                <span className="faint">{fmtDate(c.ts)}</span>
                <span className="grow"></span>
                {mayDelete(c) && (
                  <IconButton
                    icon="✕"
                    title={t('Delete comment')}
                    onClick={async () => {
                      if (await confirmAction(t('Delete this comment?'))) send('notes/deleteComment', { id: page.id, commentId: c.id });
                    }}
                  />
                )}
              </div>
              <div className="notes-comment-text">{c.text}</div>
            </div>
          ))}
          {allowed && (
            <div className="notes-comment-form">
              <textarea
                className="input"
                rows={2}
                value={text}
                maxLength={2000}
                placeholder={t('Add a comment… (Ctrl+Enter to send)')}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    post();
                  }
                }}
              ></textarea>
              <Button small variant="primary" disabled={busy || !text.trim()} onClick={post}>
                {t('Comment')}
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
