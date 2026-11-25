// Player dossiers: the party, received handouts (unread tracking), and « L'histoire jusqu'ici ».
import { useEffect, useState } from 'preact/hooks';
import { html, Button, Markdown, Empty, Badge } from '../../lib/ui.js';
import { useServerEvent } from '../../lib/net.js';
import { toast, openSheet, setUI } from '../../lib/ui-store.js';
import { HandoutCard, cx, usePersistent, handoutReadKey } from './common.js';

function useReadSet(userId) {
  const [ids, setIdsRaw] = usePersistent(handoutReadKey(userId), []);
  const list = Array.isArray(ids) ? ids : [];
  // Nudge the shell so the « Dossiers » tab badge (read from localStorage) updates at once.
  const setIds = (v) => {
    setIdsRaw(v);
    setUI({ handoutsReadAt: Date.now() });
  };
  return {
    has: (id) => list.includes(id),
    mark: (id) => !list.includes(id) && setIds([...list, id].slice(-500)),
    markAll: (all) => setIds([...new Set([...list, ...all])].slice(-500)),
  };
}

function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

function Party({ game }) {
  const pcs = Object.values(game.actors || {}).filter((a) => a && a.type === 'pc' && !a.retired);
  if (!pcs.length) return null;
  const users = Object.values(game.users || {});
  const mine = game.me.characterIds || [];
  return html`<section class="dos-section">
    <h3 class="dos-h">L'équipe</h3>
    <div class="dos-party">
      ${pcs.map((a) => {
        const owner = users.find((u) => (u.characterIds || []).includes(a.id));
        const online = owner && (game.online || []).includes(owner.id);
        const isMine = mine.includes(a.id);
        const sub = [a.metatype, a.concept].filter(Boolean).join(' · ');
        return html`<button class=${cx('dos-pc', isMine && 'mine')} disabled=${!isMine} title=${isMine ? 'Ouvrir ma fiche' : a.name}
          onClick=${() => isMine && openSheet(a.id)} style=${{ '--pc-color': a.color || 'var(--cyan)' }}>
          <span class="dos-portrait">
            ${a.portrait ? html`<img src=${a.portrait} alt="" loading="lazy" />` : html`<span>${initials(a.name)}</span>`}
          </span>
          <span class="dos-pc-text">
            <strong>${a.name}</strong>
            ${sub && html`<span class="small muted">${sub}</span>`}
            <span class="small faint">
              ${owner ? html`<span class=${cx('camp-dot', online && 'on')}></span> ${owner.name}${isMine ? ' (toi)' : ''}` : a.player || 'Libre'}
            </span>
          </span>
        </button>`;
      })}
    </div>
  </section>`;
}

export default function DossiersPage({ game }) {
  const handouts = [...(game.campaign?.handouts || [])].sort((a, b) => (b.revealedAt || b.ts || 0) - (a.revealedAt || a.ts || 0));
  const recap = game.campaign?.playerRecap || '';
  const read = useReadSet(game.me.id);
  const [openId, setOpenId] = useState(null);
  const unread = handouts.filter((h) => !read.has(h.id));
  // Documents unread when the page opened keep their highlight until the player leaves the page.
  const [fresh, setFresh] = useState(() => unread.map((h) => h.id));
  const isNew = (h) => !read.has(h.id) || fresh.includes(h.id);

  useServerEvent('campaign/handout', (d) => d?.title && toast(`Nouveau document : ${d.title}`, 'info', 5000), []);

  // Open the newest unread document automatically the first time the page is shown.
  useEffect(() => {
    if (openId === null && unread.length) {
      setOpenId(unread[0].id);
      read.mark(unread[0].id);
    }
  }, []);

  const toggle = (h) => {
    read.mark(h.id);
    setOpenId(openId === h.id ? '' : h.id);
  };

  return html`<div class="page dos-page">
    <div class="page-title">
      <h2>Dossiers</h2>
      ${unread.length > 0 && html`<${Badge} color="magenta">${unread.length} non lu${unread.length > 1 ? 's' : ''}</${Badge}>`}
    </div>
    <${Party} game=${game} />
    <div class="dos-layout">
      <section class="dos-section dos-docs">
        <div class="row spread">
          <h3 class="dos-h">Documents reçus <span class="faint small">${handouts.length || ''}</span></h3>
          ${handouts.some(isNew) && html`<${Button} small variant="ghost" onClick=${() => {
            read.markAll(handouts.map((h) => h.id));
            setFresh([]);
          }}>Tout marquer comme lu</${Button}>`}
        </div>
        ${handouts.length
          ? html`<div class="dos-list">
              ${handouts.map((h) => html`<${HandoutCard} key=${h.id} handout=${h} unread=${isNew(h)} open=${openId === h.id}
                stamp=${h.toAll ? 'Équipe' : 'Personnel'} onToggle=${() => toggle(h)} />`)}
            </div>`
          : html`<div class="dos-empty">Aucun document pour l'instant.<br /><span class="faint small">Ce que le MJ te transmettra (preuves, messages, fiches de contact…) apparaîtra ici.</span></div>`}
      </section>
      <section class="dos-section dos-story">
        <h3 class="dos-h">L'histoire jusqu'ici</h3>
        ${recap.trim()
          ? html`<div class="dos-journal"><${Markdown} text=${recap} /></div>`
          : html`<${Empty}>Le MJ n'a pas encore écrit de récapitulatif.</${Empty}>`}
      </section>
    </div>
  </div>`;
}
