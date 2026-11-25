// GM narrative threads: kanban board by state, quick state change (buttons or drag & drop).
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, Button, IconButton, TextInput, SearchBox, confirmAction } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { campaignOf, THREAD_STATES, MdEditor, cx } from './common.js';

function ThreadCard({ thread, open, onToggle, highlight }) {
  const ref = useRef(null);
  useEffect(() => {
    if (highlight && ref.current) ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlight]);
  const patch = (p) => send('campaign/updateThread', { threadId: thread.id, patch: p });
  return html`<div ref=${ref} class=${cx('camp-thread', `ts-${thread.state}`, open && 'open', highlight && 'flash')} draggable=${!open}
    onDragStart=${(e) => {
      e.dataTransfer.setData('text/plain', thread.id);
      e.dataTransfer.effectAllowed = 'move';
    }}>
    <div class="camp-thread-head" onClick=${onToggle}>
      ${open
        ? html`<div class="grow" onClick=${(e) => e.stopPropagation()}>
            <${TextInput} value=${thread.label} onChange=${(label) => label.trim() && patch({ label })} />
          </div>`
        : html`<div class="grow camp-thread-label">${thread.label}</div>`}
      <span class=${cx('camp-chev', open && 'open')}>›</span>
    </div>
    ${!open && thread.notes && html`<div class="camp-thread-notes small muted">${thread.notes.replace(/[*_#>`]/g, '').slice(0, 160)}${thread.notes.length > 160 ? '…' : ''}</div>`}
    <div class="camp-thread-states" onClick=${(e) => e.stopPropagation()}>
      ${THREAD_STATES.map(
        (s) => html`<button class=${cx('camp-ts-btn', `ts-${s.id}`, s.id === thread.state && 'active')} title=${`Passer en « ${s.one} »`}
          onClick=${() => s.id !== thread.state && patch({ state: s.id })}>${s.one}</button>`
      )}
    </div>
    ${open &&
    html`<div class="camp-thread-body">
      <${MdEditor} value=${thread.notes} rows=${6} initialMode=${thread.notes ? 'preview' : 'edit'} onSave=${(notes) => patch({ notes })} />
      <div class="row spread camp-mt">
        <div class="row gap-s">
          <${IconButton} icon="↑" title="Monter" onClick=${() => send('campaign/moveThread', { threadId: thread.id, dir: -1 })} />
          <${IconButton} icon="↓" title="Descendre" onClick=${() => send('campaign/moveThread', { threadId: thread.id, dir: 1 })} />
        </div>
        <${Button} small variant="danger" onClick=${async () => {
          if (await confirmAction(`Supprimer le fil « ${thread.label} » ?`)) send('campaign/deleteThread', { threadId: thread.id });
        }}>Supprimer</${Button}>
      </div>
    </div>`}
  </div>`;
}

export default function ThreadsView({ game, focus }) {
  const c = campaignOf(game);
  const [openId, setOpenId] = useState(null);
  const [over, setOver] = useState(null);
  const [q, setQ] = useState('');
  const [flash, setFlash] = useState(null);
  const [k, setK] = useState(0);

  useEffect(() => {
    if (!focus) return;
    setOpenId(focus.id);
    setFlash(focus.id);
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [focus?.nonce]);

  const needle = q.trim().toLowerCase();
  const match = (t) => !needle || (t.label + ' ' + t.notes).toLowerCase().includes(needle);
  const add = async (state, label) => {
    const l = String(label || '').trim();
    if (!l) return;
    const id = await send('campaign/addThread', { label: l, state }).catch(() => null);
    setK(k + 1);
    if (id) setFlash(id);
  };

  return html`<div class="camp-threads">
    <div class="camp-toolbar">
      <${SearchBox} value=${q} onChange=${setQ} placeholder="Chercher un fil…" />
      <span class="muted small">Glisse une carte d'une colonne à l'autre, ou utilise les boutons d'état.</span>
    </div>
    <div class="camp-board">
      ${THREAD_STATES.map((s) => {
        const items = c.threads.filter((t) => t.state === s.id);
        return html`<section class=${cx('camp-col', `ts-${s.id}`, over === s.id && 'over')}
          onDragOver=${(e) => {
            e.preventDefault();
            if (over !== s.id) setOver(s.id);
          }}
          onDragLeave=${(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) setOver(null);
          }}
          onDrop=${(e) => {
            e.preventDefault();
            setOver(null);
            const id = e.dataTransfer.getData('text/plain');
            const t = c.threads.find((x) => x.id === id);
            if (t && t.state !== s.id) send('campaign/updateThread', { threadId: id, patch: { state: s.id } });
          }}>
          <header class="camp-col-head"><span>${s.label}</span><span class="mono">${items.length}</span></header>
          <div class="camp-col-body">
            ${items.filter(match).map((t) => html`<${ThreadCard} key=${t.id} thread=${t} open=${openId === t.id} highlight=${flash === t.id}
              onToggle=${() => setOpenId(openId === t.id ? null : t.id)} />`)}
            ${!items.length && html`<div class="faint small camp-none">Vide</div>`}
          </div>
          <div class="camp-col-add"><${TextInput} key=${s.id + k} value="" placeholder="+ Nouveau fil (Entrée)" onChange=${(v) => add(s.id, v)} /></div>
        </section>`;
      })}
    </div>
  </div>`;
}
