// GM campaign dashboard: everything needed at the table in one screen.
import { html, Panel, Button, Badge, Markdown, Empty } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import {
  campaignOf, currentAct, nextSession, QUEST_STATUS_BY_ID, THREAD_STATES, npcInfo, mapInfo, spawnNpc,
  showMapToPlayers, openMap, revealHandout, useDocs, docTitle, DocButton, cx, fmtSessionDate,
} from './common.js';

function Progress({ phases }) {
  const done = phases.filter((p) => p.done).length;
  const pct = phases.length ? Math.round((done / phases.length) * 100) : 0;
  return html`<div class="camp-progress" title=${`${done} / ${phases.length} phases`}>
    <div class="camp-progress-bar"><span style=${{ width: pct + '%' }}></span></div>
    <span class="mono small muted">${done}/${phases.length}</span>
  </div>`;
}

function ActiveQuest({ game, quest, nav }) {
  const next = quest.phases.filter((p) => !p.done).slice(0, 2);
  const activeMap = game.scene?.activeMapId;
  return html`<div class="camp-dq">
    <div class="row spread wrap">
      <button class="camp-link camp-dq-title" onClick=${() => nav.open('quest', quest.id)}>${quest.title}</button>
      <${Progress} phases=${quest.phases} />
    </div>
    ${next.length
      ? html`<ul class="camp-checklist">
          ${next.map(
            (p) => html`<li>
              <label class="camp-check">
                <input type="checkbox" checked=${p.done} onChange=${() => send('campaign/togglePhase', { questId: quest.id, phaseId: p.id })} />
                <span>${p.title}</span>
              </label>
            </li>`
          )}
        </ul>`
      : html`<div class="muted small">Toutes les phases sont cochées — penser à clore la quête.</div>`}
    <div class="camp-quick">
      ${quest.npcs.map((id) => {
        const n = npcInfo(game, id);
        return html`<span class=${cx('camp-chip', n.kind === 'missing' && 'missing')} title=${n.kind === 'missing' ? `Fiche introuvable : ${id}` : n.folder}>
          ☠ ${n.name}
          ${n.kind === 'template' && html`<button class="camp-chip-act" title="Placer sur la carte" onClick=${() => spawnNpc(game, id)}>+ Placer</button>`}
        </span>`;
      })}
      ${quest.maps.map((id) => {
        const m = mapInfo(game, id);
        return html`<span class=${cx('camp-chip camp-chip-map', !m.exists && 'missing', activeMap === id && 'live')} title=${m.exists ? '' : `Carte introuvable : ${id}`}>
          ▦ ${m.name}
          ${m.exists &&
          html`<button class="camp-chip-act" title="Ouvrir la carte" onClick=${() => openMap(id)}>Ouvrir</button>
            ${activeMap === id
              ? html`<span class="camp-live">● En jeu</span>`
              : html`<button class="camp-chip-act" title="Afficher aux joueurs" onClick=${() => showMapToPlayers(game, id)}>Afficher</button>`}`}
        </span>`;
      })}
      ${quest.doc && html`<${DocButton} docRef=${quest.doc} nav=${nav} />`}
    </div>
  </div>`;
}

export default function Dashboard({ game, nav }) {
  const c = campaignOf(game);
  const act = currentAct(c);
  const docs = useDocs();
  const active = c.quests.filter((q) => q.status === 'active');
  const actQuests = act ? c.quests.filter((q) => q.actId === act.id) : [];
  const upcomingInAct = actQuests.filter((q) => q.status === 'upcoming');
  const session = nextSession(c);
  const lastPlayed = [...c.sessions].filter((s) => s.played).sort((a, b) => b.number - a.number)[0];
  const pending = c.handouts.filter((h) => h.revealedTo !== 'all' && !(h.revealedTo || []).length);

  return html`<div class="camp-dash">
    <div class="camp-dash-main">
      <${Panel} title="Acte en cours" class="camp-dash-act"
        actions=${html`<select class="input camp-mini-select" value=${c.currentActId || ''} title="Choisir l'acte en cours"
          onChange=${(e) => send('campaign/setCurrentAct', { actId: e.target.value || null })}>
          <option value="">Automatique</option>
          ${c.acts.map((a) => html`<option value=${a.id}>${a.title}</option>`)}
        </select>`}>
        ${act
          ? html`<h3 class="camp-act-title">${act.title}</h3>
              <${Markdown} class="camp-act-summary" text=${act.summary} />
              <div class="row wrap gap-s">
                ${actQuests.map((q) => {
                  const st = QUEST_STATUS_BY_ID[q.status];
                  return html`<button class=${cx('camp-qpill', `st-${q.status}`)} title=${st?.label} onClick=${() => nav.open('quest', q.id)}>${q.title}</button>`;
                })}
              </div>`
          : html`<${Empty}>Aucun acte défini.</${Empty}>`}
      </${Panel}>

      <${Panel} title=${`Quêtes en cours (${active.length})`} actions=${html`<${Button} small variant="ghost" onClick=${() => nav.go('quests')}>Toutes les quêtes</${Button}>`}>
        ${active.length
          ? active.map((q) => html`<${ActiveQuest} game=${game} quest=${q} nav=${nav} />`)
          : html`<div class="muted">Aucune quête en cours.${upcomingInAct.length
              ? html` Prochaine possible : <button class="camp-link" onClick=${() => send('campaign/setQuestStatus', { questId: upcomingInAct[0].id, status: 'active' })}>lancer « ${upcomingInAct[0].title} »</button>`
              : null}</div>`}
      </${Panel}>

      <${Panel} title=${session ? `Prochaine séance — n°${session.number}` : 'Prochaine séance'}
        actions=${html`${session?.doc && html`<${DocButton} docRef=${session.doc} nav=${nav} />`}
          ${session
            ? html`<${Button} small variant="ghost" onClick=${() => nav.open('session', session.id)}>Ouvrir</${Button}>`
            : html`<${Button} small onClick=${async () => {
                const id = await send('campaign/addSession', {});
                nav.open('session', id);
              }}>+ Préparer la prochaine séance</${Button}>`}`}>
        ${session
          ? html`<div class="row spread wrap"><h3 class="camp-sess-title">${session.title || `Séance ${session.number}`}</h3>
                ${session.date && html`<span class="muted small">${fmtSessionDate(session.date)}</span>`}</div>
              ${session.plan ? html`<${Markdown} class="camp-dash-plan" text=${session.plan} />` : html`<div class="muted">Plan encore vide.</div>`}
              <div class="row gap-s camp-mt">
                <${Button} small onClick=${() => send('campaign/updateSession', { sessionId: session.id, patch: { played: true } })}>✓ Marquer comme jouée</${Button}>
              </div>`
          : html`<div class="muted">Toutes les séances prévues ont été jouées.</div>`}
        ${lastPlayed &&
        html`<details class="camp-details">
          <summary>Dernière séance jouée — n°${lastPlayed.number} ${lastPlayed.title ? `· ${lastPlayed.title}` : ''}</summary>
          ${lastPlayed.recap ? html`<${Markdown} text=${lastPlayed.recap} />` : html`<div class="muted small">Pas encore de récap.</div>`}
        </details>`}
      </${Panel}>
    </div>

    <div class="camp-dash-side">
      <${Panel} title="Fils narratifs" actions=${html`<${Button} small variant="ghost" onClick=${() => nav.go('threads')}>Tableau</${Button}>`}>
        <div class="camp-thread-counts">
          ${THREAD_STATES.map((s) => html`<div class=${`camp-tc tc-${s.id}`}><span class="mono">${c.threads.filter((t) => t.state === s.id).length}</span><span>${s.label}</span></div>`)}
        </div>
        <ul class="camp-thread-list">
          ${c.threads
            .filter((t) => t.state === 'open')
            .map((t) => html`<li><button class="camp-link" title=${t.notes} onClick=${() => nav.open('thread', t.id)}>${t.label}</button></li>`)}
        </ul>
      </${Panel}>

      <${Panel} title=${`Documents à révéler (${pending.length})`} actions=${html`<${Button} small variant="ghost" onClick=${() => nav.go('handouts')}>Gérer</${Button}>`}>
        ${pending.length
          ? html`<ul class="camp-pending">
              ${pending.map(
                (h) => html`<li>
                  <button class="camp-link grow" onClick=${() => nav.open('handout', h.id)}>${h.title}</button>
                  <${Button} small variant="accent" title="Révéler à tous les joueurs" onClick=${() => revealHandout(h.id, 'all')}>Révéler</${Button}>
                </li>`
              )}
            </ul>`
          : html`<div class="muted small">Tous les documents préparés ont été montrés.</div>`}
      </${Panel}>

      <${Panel} title="Documents de campagne" actions=${html`<${Button} small variant="ghost" onClick=${() => nav.go('docs')}>Lecteur</${Button}>`}>
        ${docs.error
          ? html`<div class="error small">${docs.error}</div>`
          : docs.loading
            ? html`<div class="muted small">Chargement…</div>`
            : docs.list.length
              ? html`<div class="camp-doc-links">${docs.list.map((d) => html`<button class="camp-doc-link" onClick=${() => nav.openDoc(d.name)}>❐ ${docTitle(d.name)}</button>`)}</div>`
              : html`<div class="muted small">Aucun document .md trouvé.</div>`}
      </${Panel}>

      <${Panel} title="Raccourcis">
        <div class="col gap-s">
          <${Button} small onClick=${() => nav.go('notes')}>✎ Notes MJ</${Button}>
          <${Button} small onClick=${() => nav.go('recap')}>✉ Récap joueurs</${Button}>
        </div>
      </${Panel}>
    </div>
  </div>`;
}
