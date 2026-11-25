// GM quests: grouped by act, expandable quest editor with phases, linked NPCs/maps, rewards, notes.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, Button, IconButton, TextInput, SearchBox, Empty, Badge, confirmAction } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { openSheet } from '../../lib/ui-store.js';
import {
  campaignOf, QUEST_STATUS, MdEditor, npcInfo, mapInfo, templateOptions, mapOptions, groupedOptions,
  spawnNpc, showMapToPlayers, openMap, useDocs, DocSelect, DocButton, cx, usePersistent, parseDocRef,
} from './common.js';

const FILTERS = [
  { id: 'all', label: 'Toutes' },
  { id: 'active', label: 'En cours' },
  { id: 'upcoming', label: 'À venir' },
  { id: 'done', label: 'Terminées' },
  { id: 'skipped', label: 'Ignorées' },
];

function StatusSelect({ quest }) {
  return html`<select class=${cx('input camp-status-select', `st-${quest.status}`)} value=${quest.status} title="Statut"
    onClick=${(e) => e.stopPropagation()}
    onChange=${(e) => send('campaign/setQuestStatus', { questId: quest.id, status: e.target.value })}>
    ${QUEST_STATUS.map((s) => html`<option value=${s.id}>${s.label}</option>`)}
  </select>`;
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------
function Phase({ quest, phase, index, count, editing }) {
  const [open, setOpen] = useState(false);
  const q = { questId: quest.id, phaseId: phase.id };
  return html`<li class=${cx('camp-phase', phase.done && 'done', open && 'open')}>
    <div class="camp-phase-row">
      <input type="checkbox" class="camp-cb" checked=${phase.done} title=${phase.done ? 'Marquer comme non faite' : 'Marquer comme faite'}
        onChange=${(e) => send('campaign/togglePhase', { ...q, done: e.target.checked })} />
      ${editing
        ? html`<${TextInput} class="camp-phase-title-input" value=${phase.title} onChange=${(title) => send('campaign/updatePhase', { ...q, patch: { title } })} />`
        : html`<button class="camp-phase-title" onClick=${() => setOpen(!open)}>
            <span class="mono faint">${index + 1}.</span> ${phase.title}
            ${phase.text && html`<span class=${cx('camp-chev', open && 'open')}>›</span>`}
          </button>`}
      ${editing &&
      html`<div class="row gap-s">
        <${IconButton} icon="↑" title="Monter" disabled=${index === 0} onClick=${() => send('campaign/movePhase', { ...q, dir: -1 })} />
        <${IconButton} icon="↓" title="Descendre" disabled=${index === count - 1} onClick=${() => send('campaign/movePhase', { ...q, dir: 1 })} />
        <${IconButton} icon="✎" title="Détails" onClick=${() => setOpen(!open)} />
        <${IconButton} icon="✕" title="Supprimer la phase" onClick=${async () => {
          if (await confirmAction(`Supprimer la phase « ${phase.title} » ?`)) send('campaign/deletePhase', q);
        }} />
      </div>`}
    </div>
    ${open &&
    html`<div class="camp-phase-text">
      <${MdEditor} value=${phase.text} rows=${6} initialMode=${phase.text ? 'preview' : 'edit'} emptyText="Pas de détail pour cette phase."
        onSave=${(text) => send('campaign/updatePhase', { ...q, patch: { text } })} />
    </div>`}
  </li>`;
}

function Phases({ quest }) {
  const [editing, setEditing] = useState(false);
  const [k, setK] = useState(0);
  const add = async (title) => {
    const t = String(title || '').trim();
    if (!t) return;
    await send('campaign/addPhase', { questId: quest.id, title: t }).catch(() => {});
    setK(k + 1); // reset the input
  };
  const done = quest.phases.filter((p) => p.done).length;
  return html`<section class="camp-sec">
    <div class="camp-sec-head">
      <h4>Phases <span class="muted small">${done}/${quest.phases.length}</span></h4>
      <${Button} small variant=${editing ? 'primary' : 'ghost'} onClick=${() => setEditing(!editing)}>${editing ? 'Terminer' : '✎ Modifier'}</${Button}>
    </div>
    ${quest.phases.length
      ? html`<ol class="camp-phases">
          ${quest.phases.map((p, i) => html`<${Phase} key=${p.id} quest=${quest} phase=${p} index=${i} count=${quest.phases.length} editing=${editing} />`)}
        </ol>`
      : html`<div class="muted small">Aucune phase.</div>`}
    ${editing &&
    html`<div class="camp-add-row">
      <${TextInput} key=${k} value="" placeholder="Nouvelle phase… (Entrée pour ajouter)" onChange=${add} />
    </div>`}
  </section>`;
}

// ---------------------------------------------------------------------------
// Linked NPCs / maps
// ---------------------------------------------------------------------------
function LinkedNpcs({ game, quest }) {
  const [pick, setPick] = useState('');
  const opts = templateOptions(game).filter((o) => !quest.npcs.includes(o.id));
  const setNpcs = (npcs) => send('campaign/updateQuest', { questId: quest.id, patch: { npcs } });
  return html`<section class="camp-sec">
    <div class="camp-sec-head"><h4>PNJ liés</h4></div>
    ${quest.npcs.length
      ? html`<ul class="camp-links">
          ${quest.npcs.map((id) => {
            const n = npcInfo(game, id);
            return html`<li class=${cx('camp-linkrow', n.kind === 'missing' && 'missing')}>
              <span class="camp-ico">☠</span>
              <div class="grow">
                <div class="camp-linkname">${n.name}</div>
                <div class="faint small">${n.kind === 'missing' ? `Fiche introuvable (${id})` : n.folder}</div>
              </div>
              ${n.kind === 'template' &&
              html`<${Button} small variant="primary" title="Placer sur la carte affichée" onClick=${() => spawnNpc(game, id)}>Placer sur la carte</${Button}>
                <${IconButton} icon="◌" title="Placer caché (invisible pour les joueurs)" onClick=${() => spawnNpc(game, id, { hidden: true })} />`}
              ${n.kind === 'actor' && html`<${Button} small onClick=${() => openSheet(id)}>Fiche</${Button}>`}
              <${IconButton} icon="✕" title="Retirer de la quête" onClick=${() => setNpcs(quest.npcs.filter((x) => x !== id))} />
            </li>`;
          })}
        </ul>`
      : html`<div class="muted small">Aucun PNJ lié.</div>`}
    <div class="camp-add-row">
      <select class="input" value=${pick} onChange=${(e) => setPick(e.target.value)}>
        <option value="">${opts.length ? '— Ajouter un PNJ du bestiaire —' : 'Bestiaire vide ou déjà tout lié'}</option>
        ${groupedOptions(opts)}
      </select>
      <${Button} small disabled=${!pick} onClick=${() => {
        setNpcs([...quest.npcs, pick]);
        setPick('');
      }}>Ajouter</${Button}>
    </div>
  </section>`;
}

function LinkedMaps({ game, quest }) {
  const [pick, setPick] = useState('');
  const opts = mapOptions(game).filter((o) => !quest.maps.includes(o.id));
  const active = game.scene?.activeMapId;
  const setMaps = (maps) => send('campaign/updateQuest', { questId: quest.id, patch: { maps } });
  return html`<section class="camp-sec">
    <div class="camp-sec-head"><h4>Cartes liées</h4></div>
    ${quest.maps.length
      ? html`<ul class="camp-links">
          ${quest.maps.map((id) => {
            const m = mapInfo(game, id);
            return html`<li class=${cx('camp-linkrow', !m.exists && 'missing', active === id && 'live')}>
              <span class="camp-ico">▦</span>
              <div class="grow">
                <div class="camp-linkname">${m.name} ${active === id && html`<${Badge} color="green">Affichée</${Badge}>`}</div>
                <div class="faint small">${m.exists ? m.folder : `Carte introuvable (${id})`}</div>
              </div>
              ${m.exists &&
              html`${active !== id && html`<${Button} small variant="primary" onClick=${() => showMapToPlayers(game, id)}>Afficher aux joueurs</${Button}>`}
                <${Button} small variant="ghost" onClick=${() => openMap(id)}>Ouvrir</${Button}>`}
              <${IconButton} icon="✕" title="Retirer de la quête" onClick=${() => setMaps(quest.maps.filter((x) => x !== id))} />
            </li>`;
          })}
        </ul>`
      : html`<div class="muted small">Aucune carte liée.</div>`}
    <div class="camp-add-row">
      <select class="input" value=${pick} onChange=${(e) => setPick(e.target.value)}>
        <option value="">${opts.length ? '— Ajouter une carte —' : 'Aucune autre carte disponible'}</option>
        ${groupedOptions(opts)}
      </select>
      <${Button} small disabled=${!pick} onClick=${() => {
        setMaps([...quest.maps, pick]);
        setPick('');
      }}>Ajouter</${Button}>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Quest card
// ---------------------------------------------------------------------------
function QuestCard({ game, quest, acts, open, onToggle, nav, docs, first, last, highlight }) {
  const ref = useRef(null);
  useEffect(() => {
    if (highlight && ref.current) ref.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [highlight]);
  const patch = (p) => send('campaign/updateQuest', { questId: quest.id, patch: p });
  const done = quest.phases.filter((p) => p.done).length;
  const nextPhase = quest.phases.find((p) => !p.done);
  const anchor = parseDocRef(quest.doc)?.anchor || '';

  return html`<article ref=${ref} class=${cx('camp-quest', `st-${quest.status}`, open && 'open', highlight && 'flash')}>
    <header class="camp-quest-head" onClick=${onToggle}>
      <span class=${cx('camp-chev', open && 'open')}>›</span>
      <div class="grow camp-quest-headtext">
        <div class="camp-quest-title">${quest.title}</div>
        ${!open && nextPhase && quest.status === 'active' && html`<div class="small muted camp-ellipsis">Prochaine : ${nextPhase.title}</div>`}
      </div>
      <span class="mono small muted" title="Phases faites">${done}/${quest.phases.length}</span>
      ${quest.npcs.length > 0 && html`<span class="small faint" title="PNJ liés">☠ ${quest.npcs.length}</span>`}
      ${quest.maps.length > 0 && html`<span class="small faint" title="Cartes liées">▦ ${quest.maps.length}</span>`}
      <${StatusSelect} quest=${quest} />
    </header>
    ${open &&
    html`<div class="camp-quest-body">
      <div class="camp-quest-meta">
        <label class="field grow"><span class="field-label">Titre</span>
          <${TextInput} value=${quest.title} onChange=${(title) => title.trim() && patch({ title })} /></label>
        <label class="field"><span class="field-label">Acte</span>
          <select class="input" value=${quest.actId} onChange=${(e) => patch({ actId: e.target.value })}>
            ${!acts.some((a) => a.id === quest.actId) && html`<option value=${quest.actId}>— Sans acte —</option>`}
            ${acts.map((a) => html`<option value=${a.id}>${a.title}</option>`)}
          </select></label>
        <label class="field"><span class="field-label">Document</span>
          <div class="row gap-s">
            <${DocSelect} value=${quest.doc} docs=${docs.list} onChange=${(name) => patch({ doc: name && anchor && parseDocRef(quest.doc)?.name === name ? `${name}#${anchor}` : name })} />
            ${quest.doc && html`<${IconButton} icon="❐" title=${'Ouvrir ' + quest.doc} onClick=${() => nav.openDoc(quest.doc)} />`}
          </div></label>
      </div>
      ${quest.doc && html`<div class="camp-mb"><${DocButton} docRef=${quest.doc} nav=${nav} label="Ouvrir le document lié" /></div>`}

      <${MdEditor} label="Résumé" value=${quest.summary} rows=${5} onSave=${(summary) => patch({ summary })} />
      <${Phases} quest=${quest} />
      <div class="grid-2">
        <${LinkedNpcs} game=${game} quest=${quest} />
        <${LinkedMaps} game=${game} quest=${quest} />
      </div>
      <div class="grid-2">
        <${MdEditor} label="Récompenses" value=${quest.rewards} rows=${5} onSave=${(rewards) => patch({ rewards })} />
        <${MdEditor} label="Notes MJ" value=${quest.gmNotes} rows=${5} onSave=${(gmNotes) => patch({ gmNotes })} />
      </div>
      <footer class="camp-quest-foot">
        <div class="row gap-s">
          <${Button} small variant="ghost" disabled=${first} title="Monter dans l'acte" onClick=${() => send('campaign/moveQuest', { questId: quest.id, dir: -1 })}>↑ Monter</${Button}>
          <${Button} small variant="ghost" disabled=${last} title="Descendre dans l'acte" onClick=${() => send('campaign/moveQuest', { questId: quest.id, dir: 1 })}>↓ Descendre</${Button}>
        </div>
        <${Button} small variant="danger" onClick=${async () => {
          if (await confirmAction(`Supprimer définitivement la quête « ${quest.title} » ?`)) send('campaign/deleteQuest', { questId: quest.id });
        }}>Supprimer la quête</${Button}>
      </footer>
    </div>`}
  </article>`;
}

// ---------------------------------------------------------------------------
// Act group
// ---------------------------------------------------------------------------
function ActHeader({ act, quests, onAdd }) {
  const [edit, setEdit] = useState(false);
  const [showSummary, setShowSummary] = usePersistent(`sr.campaign.actOpen.${act.id}`, false);
  const done = quests.filter((q) => q.status === 'done' || q.status === 'skipped').length;
  return html`<div class="camp-act">
    <div class="camp-act-head">
      ${edit
        ? html`<${TextInput} class="camp-act-input" value=${act.title} onChange=${(title) => title.trim() && send('campaign/updateAct', { actId: act.id, patch: { title } })} />`
        : html`<button class="camp-act-name" onClick=${() => setShowSummary(!showSummary)}>
            <span class=${cx('camp-chev', showSummary && 'open')}>›</span> ${act.title}
          </button>`}
      <span class="muted small">${done}/${quests.length} bouclées</span>
      <span class="grow"></span>
      <${Button} small variant="ghost" onClick=${() => {
        setEdit(!edit);
        if (!edit) setShowSummary(true);
      }}>${edit ? 'Terminer' : '✎ Acte'}</${Button}>
      ${edit &&
      !quests.length &&
      html`<${Button} small variant="danger" onClick=${async () => {
        if (await confirmAction(`Supprimer l'acte « ${act.title} » ?`)) send('campaign/deleteAct', { actId: act.id });
      }}>Supprimer</${Button}>`}
      <${Button} small onClick=${onAdd}>+ Quête</${Button}>
    </div>
    ${(showSummary || edit) &&
    html`<div class="camp-act-sum">
      <${MdEditor} key=${edit ? "e" : "v"} value=${act.summary} rows=${5} initialMode=${edit ? "edit" : "preview"} onSave=${(summary) => send("campaign/updateAct", { actId: act.id, patch: { summary } })} />
    </div>`}
  </div>`;
}

export default function QuestsView({ game, nav, focus }) {
  const c = campaignOf(game);
  const docs = useDocs();
  const [filter, setFilter] = usePersistent('sr.campaign.questFilter', 'all');
  const [q, setQ] = useState('');
  const [openIds, setOpenIds] = usePersistent('sr.campaign.openQuests', []);
  const [flash, setFlash] = useState(null);

  useEffect(() => {
    if (!focus) return;
    setOpenIds((ids) => (ids.includes(focus.id) ? ids : [...ids, focus.id]));
    setFlash(focus.id);
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [focus?.nonce]);

  const toggle = (id) => setOpenIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const needle = q.trim().toLowerCase();
  const visible = (quest) =>
    (filter === 'all' || quest.status === filter) &&
    (!needle || [quest.title, quest.summary, quest.gmNotes, ...quest.phases.map((p) => p.title)].join(' ').toLowerCase().includes(needle));

  const addQuest = async (actId) => {
    const id = await send('campaign/addQuest', { actId, title: 'Nouvelle quête' }).catch(() => null);
    if (id) {
      setOpenIds((ids) => [...ids, id]);
      setFlash(id);
    }
  };
  const addAct = async () => {
    const n = c.acts.length + 1;
    await send('campaign/addAct', { title: `Acte ${n}` }).catch(() => {});
  };

  const groups = c.acts.map((act) => ({ act, quests: c.quests.filter((x) => x.actId === act.id) }));
  const orphans = c.quests.filter((x) => !c.acts.some((a) => a.id === x.actId));

  const renderList = (quests) => {
    const shown = quests.filter(visible);
    if (!shown.length) return html`<div class="muted small camp-none">${quests.length ? 'Aucune quête ne correspond au filtre.' : 'Pas encore de quête dans cet acte.'}</div>`;
    return shown.map((quest) => {
      const i = quests.indexOf(quest);
      return html`<${QuestCard} key=${quest.id} game=${game} quest=${quest} acts=${c.acts} nav=${nav} docs=${docs}
        open=${openIds.includes(quest.id)} onToggle=${() => toggle(quest.id)} first=${i === 0} last=${i === quests.length - 1}
        highlight=${flash === quest.id} />`;
    });
  };

  return html`<div class="camp-quests">
    <div class="camp-toolbar">
      <div class="camp-seg">
        ${FILTERS.map((f) => {
          const count = f.id === 'all' ? c.quests.length : c.quests.filter((x) => x.status === f.id).length;
          return html`<button class=${cx(filter === f.id && 'active')} onClick=${() => setFilter(f.id)}>${f.label} <span class="faint">${count}</span></button>`;
        })}
      </div>
      <${SearchBox} value=${q} onChange=${setQ} placeholder="Chercher une quête…" />
      <span class="grow"></span>
      ${openIds.length > 0 && html`<${Button} small variant="ghost" onClick=${() => setOpenIds([])}>Tout replier</${Button}>`}
      <${Button} small onClick=${addAct}>+ Acte</${Button}>
    </div>
    ${!c.acts.length && !c.quests.length && html`<${Empty}>Aucune quête. Crée d'abord un acte.</${Empty}>`}
    ${groups.map(({ act, quests }) => html`<section class="camp-act-group" key=${act.id}>
      <${ActHeader} act=${act} quests=${quests} onAdd=${() => addQuest(act.id)} />
      <div class="camp-quest-list">${renderList(quests)}</div>
    </section>`)}
    ${orphans.length > 0 &&
    html`<section class="camp-act-group">
      <div class="camp-act"><div class="camp-act-head"><span class="camp-act-name">Sans acte</span></div></div>
      <div class="camp-quest-list">${renderList(orphans)}</div>
    </section>`}
  </div>`;
}
