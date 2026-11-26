// Comments under a party note (or a private note shared with the GM).
import { useState } from 'preact/hooks';
import { html, Button, IconButton, confirmAction } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { t, tn, fmtDate } from '../../lib/i18n.js';
import { cx, canComment, storedName, isGM } from './common.js';

export function NoteComments({ game, page }) {
  const list = game.notes?.comments?.[page.id] || [];
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

  const mayDelete = (c) => c.userId === game.me.id || isGM(game) || (page.scope === 'private' && page.ownerId === game.me.id);

  return html`<section class=${cx('notes-comments', open && 'open')}>
    <button class="notes-comments-head" onClick=${() => setOpen(!open)} aria-expanded=${open ? 'true' : 'false'}>
      <span>${open ? '▾' : '▸'}</span>
      <span>${list.length ? tn(list.length, '{n} commentaire', '{n} commentaires') : t('Commentaires')}</span>
    </button>
    ${open &&
    html`<div class="notes-comments-body">
      ${list.map(
        (c) => html`<div class=${cx('notes-comment', c.userId === game.me.id && 'mine', c.userId === 'gm' && 'gm')} key=${c.id}>
          <div class="row small">
            <strong>${storedName(game, c.userId, c.author)}</strong>
            <span class="faint">${fmtDate(c.ts)}</span>
            <span class="grow"></span>
            ${mayDelete(c) &&
            html`<${IconButton} icon="✕" title=${t('Supprimer le commentaire')}
              onClick=${async () => (await confirmAction(t('Supprimer ce commentaire ?'))) && send('notes/deleteComment', { id: page.id, commentId: c.id })} />`}
          </div>
          <div class="notes-comment-text">${c.text}</div>
        </div>`
      )}
      ${allowed &&
      html`<div class="notes-comment-form">
        <textarea class="input" rows="2" value=${text} maxlength="2000" placeholder=${t('Ajouter un commentaire… (Ctrl+Entrée pour envoyer)')}
          onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && (e.preventDefault(), post())}></textarea>
        <${Button} small variant="primary" disabled=${busy || !text.trim()} onClick=${post}>${t('Commenter')}</${Button}>
      </div>`}
    </div>`}
  </section>`;
}
