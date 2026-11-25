// GM sessions: numbered list, plan & recap editors, played flag, linked doc.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, Button, Badge, Toggle, TextInput, Empty, Tabs, confirmAction } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { campaignOf, MdEditor, useDocs, DocSelect, DocButton, cx, fmtSessionDate, nextSession, usePersistent } from './common.js';

function SessionCard({ session, open, onToggle, nav, docs, isNext, highlight }) {
  const [part, setPart] = useState(session.played ? 'recap' : 'plan');
  const ref = useRef(null);
  useEffect(() => {
    if (highlight && ref.current) ref.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [highlight]);
  const patch = (p) => send('campaign/updateSession', { sessionId: session.id, patch: p });
  const recapTodo = session.played && (!session.recap.trim() || /à compléter/i.test(session.recap));

  return html`<article ref=${ref} class=${cx('camp-session', session.played && 'played', isNext && 'next', open && 'open', highlight && 'flash')}>
    <header class="camp-session-head" onClick=${onToggle}>
      <div class="camp-session-num">${session.number}</div>
      <div class="grow camp-quest-headtext">
        <div class="camp-quest-title">${session.title || `Séance ${session.number}`}</div>
        <div class="small muted">${session.date ? fmtSessionDate(session.date) : 'Date non fixée'}</div>
      </div>
      ${recapTodo && html`<${Badge} color="amber" title="Le récap de cette séance reste à écrire">Récap à faire</${Badge}>`}
      ${session.played ? html`<${Badge} color="green">Jouée</${Badge}>` : isNext ? html`<${Badge} color="cyan">Prochaine</${Badge}>` : html`<${Badge}>Prévue</${Badge}>`}
      <span class=${cx('camp-chev', open && 'open')}>›</span>
    </header>
    ${open &&
    html`<div class="camp-quest-body">
      <div class="camp-quest-meta">
        <label class="field camp-num-field"><span class="field-label">N°</span>
          <${TextInput} type="number" min="1" value=${String(session.number)} onChange=${(v) => Number(v) > 0 && patch({ number: Number(v) })} /></label>
        <label class="field grow"><span class="field-label">Titre</span>
          <${TextInput} value=${session.title} placeholder=${`Séance ${session.number}`} onChange=${(title) => patch({ title })} /></label>
        <label class="field"><span class="field-label">Date</span>
          <${TextInput} type="date" value=${session.date} onChange=${(date) => patch({ date })} /></label>
        <div class="field"><span class="field-label">Jouée</span>
          <${Toggle} value=${session.played} onChange=${(played) => {
            patch({ played });
            if (played) setPart('recap');
          }} label=${session.played ? 'Oui' : 'Non'} /></div>
        <label class="field"><span class="field-label">Document</span>
          <div class="row gap-s">
            <${DocSelect} value=${session.doc} docs=${docs.list} onChange=${(doc) => patch({ doc })} />
            ${session.doc && html`<${DocButton} docRef=${session.doc} nav=${nav} label="Ouvrir" />`}
          </div></label>
      </div>
      <${Tabs} tabs=${[{ id: 'plan', label: 'Plan' }, { id: 'recap', label: 'Récap', badge: recapTodo ? '!' : null }]} value=${part} onChange=${setPart} />
      ${part === 'plan'
        ? html`<${MdEditor} key="plan" value=${session.plan} rows=${14} initialMode=${session.plan ? 'preview' : 'edit'}
            placeholder="Scènes prévues, PNJ, cartes, points à ne pas oublier…" onSave=${(plan) => patch({ plan })} />`
        : html`<${MdEditor} key="recap" value=${session.recap} rows=${14} initialMode=${session.recap ? 'preview' : 'edit'}
            placeholder="Ce qui s'est réellement passé à la table…" onSave=${(recap) => patch({ recap })} />`}
      <footer class="camp-quest-foot">
        <span class="faint small">Astuce : pense à reporter l'essentiel (sans secrets) dans le « Récap joueurs ».</span>
        <${Button} small variant="danger" onClick=${async () => {
          if (await confirmAction(`Supprimer la séance n°${session.number} ?`)) send('campaign/deleteSession', { sessionId: session.id });
        }}>Supprimer</${Button}>
      </footer>
    </div>`}
  </article>`;
}

export default function SessionsView({ game, nav, focus }) {
  const c = campaignOf(game);
  const docs = useDocs();
  const sessions = [...c.sessions].sort((a, b) => a.number - b.number);
  const next = nextSession(c);
  const [openIds, setOpenIds] = usePersistent('sr.campaign.openSessions', next ? [next.id] : []);
  const [flash, setFlash] = useState(null);
  const [newestFirst, setNewestFirst] = usePersistent('sr.campaign.sessionsNewest', true);

  useEffect(() => {
    if (!focus) return;
    setOpenIds((ids) => (ids.includes(focus.id) ? ids : [...ids, focus.id]));
    setFlash(focus.id);
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [focus?.nonce]);

  const toggle = (id) => setOpenIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const add = async () => {
    const id = await send('campaign/addSession', {}).catch(() => null);
    if (id) {
      setOpenIds((ids) => [...ids, id]);
      setFlash(id);
    }
  };
  const list = newestFirst ? [...sessions].reverse() : sessions;

  return html`<div class="camp-sessions">
    <div class="camp-toolbar">
      <span class="muted small">${sessions.filter((s) => s.played).length} jouée(s) · ${sessions.filter((s) => !s.played).length} prévue(s)</span>
      <span class="grow"></span>
      <${Button} small variant="ghost" onClick=${() => setNewestFirst(!newestFirst)}>${newestFirst ? '↓ Plus récentes d\'abord' : '↑ Plus anciennes d\'abord'}</${Button}>
      <${Button} small variant="primary" onClick=${add}>+ Nouvelle séance</${Button}>
    </div>
    ${list.length
      ? list.map((s) => html`<${SessionCard} key=${s.id} session=${s} nav=${nav} docs=${docs} isNext=${next?.id === s.id}
          open=${openIds.includes(s.id)} onToggle=${() => toggle(s.id)} highlight=${flash === s.id} />`)
      : html`<${Empty}>Aucune séance. Crée la première !</${Empty}>`}
  </div>`;
}
