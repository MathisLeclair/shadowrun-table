// GM handouts: editor (title, markdown, image), reveal to all / specific players, hide, player preview.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, Button, Badge, TextInput, Modal, Empty, SearchBox, confirmAction } from '../../lib/ui.js';
import { send, upload } from '../../lib/net.js';
import { toast } from '../../lib/ui-store.js';
import { campaignOf, MdEditor, HandoutCard, cx, fmtDate, usePersistent, revealHandout } from './common.js';

function players(game) {
  return Object.values(game.users || {})
    .filter((u) => u && u.id !== 'gm')
    .map((u) => ({
      ...u,
      chars: (u.characterIds || []).map((id) => game.actors?.[id]?.name).filter(Boolean),
      online: (game.online || []).includes(u.id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

function visibility(h, list) {
  if (h.revealedTo === 'all') return { label: 'Tous les joueurs', color: 'green' };
  const ids = h.revealedTo || [];
  if (!ids.length) return { label: 'Secret', color: 'dim' };
  const names = ids.map((id) => list.find((u) => u.id === id)?.name || '?');
  return { label: names.length > 2 ? `${names.length} joueurs` : names.join(', '), color: 'cyan' };
}

function ImageField({ handout }) {
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const set = (image) => send('campaign/updateHandout', { handoutId: handout.id, patch: { image } });
  const pick = async (file) => {
    if (!file) return;
    if (!/^image\//.test(file.type)) return toast('Choisis une image (png, jpg, webp, gif, svg)', 'warn');
    setBusy(true);
    try {
      const res = await upload(file);
      await set(res.url);
      toast('Image ajoutée', 'success');
    } catch (err) {
      toast(`Envoi impossible : ${err.message}`, 'error');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return html`<div class="camp-sec">
    <div class="camp-sec-head"><h4>Image</h4></div>
    <div class="camp-img-field" onDragOver=${(e) => e.preventDefault()} onDrop=${(e) => {
      e.preventDefault();
      pick(e.dataTransfer.files?.[0]);
    }}>
      ${handout.image
        ? html`<img src=${handout.image} alt="" class="camp-img-thumb" />`
        : html`<div class="camp-img-empty faint small">Glisse une image ici ou utilise le bouton.</div>`}
      <div class="col gap-s">
        <input ref=${input} type="file" accept="image/*" class="hidden" onChange=${(e) => pick(e.target.files?.[0])} />
        <${Button} small disabled=${busy} onClick=${() => input.current?.click()}>${busy ? 'Envoi…' : handout.image ? 'Remplacer' : 'Téléverser une image'}</${Button}>
        ${handout.image && html`<${Button} small variant="ghost" onClick=${() => set('')}>Retirer l'image</${Button}>`}
      </div>
    </div>
    <${TextInput} class="camp-mt" value=${handout.image} placeholder="…ou colle une URL (/uploads/…, https://…)" onChange=${(v) => set(v.trim())} />
  </div>`;
}

function RevealPanel({ game, handout }) {
  const list = players(game);
  const all = handout.revealedTo === 'all';
  const ids = all ? list.map((u) => u.id) : handout.revealedTo || [];
  const togglePlayer = (u, on) =>
    on ? revealHandout(handout.id, [u.id]) : send('campaign/hideHandout', { handoutId: handout.id, userId: u.id });
  return html`<div class="camp-sec camp-reveal">
    <div class="camp-sec-head">
      <h4>Visibilité</h4>
      <${Badge} color=${visibility(handout, list).color}>${visibility(handout, list).label}</${Badge}>
    </div>
    <div class="row wrap gap-s">
      <${Button} small variant="accent" disabled=${all} onClick=${() => revealHandout(handout.id, 'all')}>✉ Révéler à tous</${Button}>
      <${Button} small variant="ghost" disabled=${!all && !ids.length} onClick=${async () => {
        if (await confirmAction(`Masquer « ${handout.title} » à tous les joueurs ?`)) send('campaign/hideHandout', { handoutId: handout.id });
      }}>Tout masquer</${Button}>
    </div>
    ${list.length
      ? html`<ul class="camp-players">
          ${list.map(
            (u) => html`<li>
              <label class="camp-check">
                <input type="checkbox" checked=${ids.includes(u.id)} onChange=${(e) => togglePlayer(u, e.target.checked)} />
                <span class=${cx('camp-dot', u.online && 'on')} title=${u.online ? 'En ligne' : 'Hors ligne'}></span>
                <span><strong>${u.name}</strong>${u.chars.length ? html` <span class="muted small">· ${u.chars.join(', ')}</span>` : null}</span>
              </label>
            </li>`
          )}
        </ul>`
      : html`<div class="muted small camp-mt">Aucun joueur connecté pour l'instant. « Révéler à tous » inclura aussi ceux qui arriveront plus tard.</div>`}
    ${handout.revealedAt && html`<div class="faint small camp-mt">Dernière révélation : ${fmtDate(handout.revealedAt)}</div>`}
  </div>`;
}

function Editor({ game, handout, onPreview }) {
  const patch = (p) => send('campaign/updateHandout', { handoutId: handout.id, patch: p });
  return html`<div class="camp-ho-editor">
    <div class="row gap-s camp-ho-titlebar">
      <label class="field grow"><span class="field-label">Titre</span>
        <${TextInput} value=${handout.title} onChange=${(title) => title.trim() && patch({ title })} /></label>
      <${Button} small onClick=${onPreview}>◉ Aperçu joueur</${Button}>
    </div>
    <${RevealPanel} game=${game} handout=${handout} />
    <${MdEditor} label="Contenu (vu par les joueurs)" value=${handout.body} rows=${14} initialMode=${handout.body ? 'preview' : 'edit'}
      placeholder="Texte du document, en markdown (tableaux, citations, gras…)" onSave=${(body) => patch({ body })} />
    <${ImageField} handout=${handout} />
    <${MdEditor} label="Note MJ (jamais montrée)" value=${handout.gmNotes} rows=${3} initialMode=${handout.gmNotes ? 'preview' : 'edit'}
      placeholder="Quand le révéler, à qui…" onSave=${(gmNotes) => patch({ gmNotes })} />
    <div class="row spread camp-mt">
      <span class="faint small">${handout.ts && handout.ts < Date.now() + 864e5 ? `Créé ${fmtDate(handout.ts)}` : "Document préparé"}</span>
      <${Button} small variant="danger" onClick=${async () => {
        if (await confirmAction(`Supprimer définitivement « ${handout.title} » ? Les joueurs ne le verront plus.`)) send('campaign/deleteHandout', { handoutId: handout.id });
      }}>Supprimer</${Button}>
    </div>
  </div>`;
}

export default function HandoutsView({ game, focus }) {
  const c = campaignOf(game);
  const list = players(game);
  const [sel, setSel] = usePersistent('sr.campaign.handout', null);
  const [preview, setPreview] = useState(false);
  const [q, setQ] = useState('');

  useEffect(() => {
    if (focus) setSel(focus.id);
  }, [focus?.nonce]);

  const selected = c.handouts.find((h) => h.id === sel) || null;
  const needle = q.trim().toLowerCase();
  const shown = c.handouts.filter((h) => !needle || (h.title + ' ' + h.body).toLowerCase().includes(needle));
  const add = async () => {
    const id = await send('campaign/addHandout', { title: 'Nouveau document' }).catch(() => null);
    if (id) setSel(id);
  };

  return html`<div class=${cx('camp-handouts', selected && 'has-sel')}>
    <aside class="camp-ho-list">
      <div class="row gap-s">
        <${SearchBox} value=${q} onChange=${setQ} placeholder="Filtrer…" />
        <${Button} small variant="primary" onClick=${add}>+ Nouveau</${Button}>
      </div>
      ${shown.length
        ? html`<ul>
            ${shown.map((h) => {
              const v = visibility(h, list);
              return html`<li><button class=${cx('camp-ho-item', h.id === sel && 'active')} onClick=${() => setSel(h.id)}>
                <span class="camp-ho-item-title">${h.image ? '▣ ' : ''}${h.title}</span>
                <${Badge} color=${v.color}>${v.label}</${Badge}>
              </button></li>`;
            })}
          </ul>`
        : html`<${Empty}>${c.handouts.length ? 'Aucun résultat.' : 'Aucun document. Crée le premier !'}</${Empty}>`}
    </aside>
    <section class="camp-ho-main">
      ${selected
        ? html`<button class="btn btn-sm btn-ghost camp-ho-back" onClick=${() => setSel(null)}>‹ Retour à la liste</button>
            <${Editor} key=${selected.id} game=${game} handout=${selected} onPreview=${() => setPreview(true)} />`
        : html`<${Empty}>Choisis un document à gauche, ou crée-en un nouveau.</${Empty}>`}
    </section>
    ${preview &&
    selected &&
    html`<${Modal} title="Aperçu — vue joueur" width=${760} onClose=${() => setPreview(false)}>
      <div class="dos-page dos-preview">
        <${HandoutCard} handout=${{ ...selected, revealedAt: selected.revealedAt || Date.now() }} unread=${true} />
      </div>
    </${Modal}>`}
  </div>`;
}
