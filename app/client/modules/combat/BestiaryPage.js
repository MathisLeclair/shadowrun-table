// Bestiary (GM): NPC templates by folder, SR5 stat blocks, spawn onto maps, editor, import/export.
import { useState, useMemo, useRef } from 'preact/hooks';
import { html, Button, Badge, Empty, Panel, NumberInput, Toggle, SearchBox, loadCss, confirmAction, promptText } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { useUI, openSheet, toast, goTab } from '../../lib/ui-store.js';
import { initials, avatarStyle, safeDerive, downloadJson, NPC_KIND_LABEL } from './combat-common.js';
import StatBlock from './StatBlock.js';
import TemplateEditor from './TemplateEditor.js';

loadCss('/modules/combat/combat.css');

const FOLDER_ORDER = ['Project Lazarus', 'Gangs', 'Sécurité corpo', 'Spécialistes', 'Matrice', 'Créatures'];
const NO_MAP = '__none';

const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

function folderSort(a, b) {
  const ia = FOLDER_ORDER.indexOf(a);
  const ib = FOLDER_ORDER.indexOf(b);
  if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  return a.localeCompare(b, 'fr');
}

function TemplateCard({ t, active, spawned, onClick }) {
  const d = safeDerive(t);
  const kind = t.npc?.kind || 'metahuman';
  return html`<div class=${'bst-card' + (active ? ' active' : '')} style=${{ '--tc': t.color || 'var(--magenta)' }} onClick=${onClick}>
    <div class="bst-card-top">
      <strong title=${t.name}>${t.name}</strong>
      ${spawned > 0 && html`<${Badge} color="green" title="PNJ de ce modèle actuellement en jeu">×${spawned}</${Badge}>`}
    </div>
    <div class="sub">${[t.metatype, t.concept].filter(Boolean).join(' · ') || '—'}</div>
    <div class="meta">
      ${t.npc?.professionalRating > 0 && html`<${Badge} color="amber">PR ${t.npc.professionalRating}</${Badge}>`}
      ${t.npc?.grunt && html`<${Badge} color="magenta">Sbire</${Badge}>`}
      ${kind !== 'metahuman' && html`<${Badge} color="cyan">${NPC_KIND_LABEL[kind] || kind}</${Badge}>`}
      ${d && kind !== 'host' && html`<span class="mono small muted">Init ${d.initiative.text}</span>`}
    </div>
  </div>`;
}

function SpawnBox({ game, t, ui }) {
  const maps = Object.values(game.maps || {}).sort((a, b) => String(a.name).localeCompare(String(b.name), 'fr'));
  const defaultMap = (ui.viewMapId && game.maps?.[ui.viewMapId] && ui.viewMapId) || game.scene?.activeMapId || maps[0]?.id || NO_MAP;
  const [count, setCount] = useState(1);
  const [hidden, setHidden] = useState(false);
  const [mapChoice, setMapChoice] = useState(null);
  const [addToCombat, setAddToCombat] = useState(true);
  const [busy, setBusy] = useState(false);
  const mapId = mapChoice && (mapChoice === NO_MAP || game.maps?.[mapChoice]) ? mapChoice : defaultMap;
  const map = mapId !== NO_MAP ? game.maps?.[mapId] : null;
  // Spawn next to the selected token when it is on that map, otherwise in the middle of the map.
  const anchor = map && (ui.selectedTokenIds || []).map((id) => (map.tokens || []).find((tk) => tk.id === id)).find(Boolean);
  const combatOn = !!game.combat?.active;
  const isHost = t.npc?.kind === 'host';

  const spawn = async () => {
    setBusy(true);
    try {
      const payload = { templateId: t.id, count, hidden, mapId: map ? map.id : null, addToCombat: combatOn && addToCombat };
      if (anchor) {
        payload.x = anchor.x;
        payload.y = anchor.y;
      }
      const res = await send('bestiary/spawn', payload);
      const n = res.actorIds.length;
      let msg = `${n} PNJ créé${n > 1 ? 's' : ''}`;
      if (map) msg += ` sur « ${map.name} »`;
      toast(msg + (hidden ? ' (cachés)' : ''), 'success');
      if (res.unplaced) toast(`${res.unplaced} PNJ sans place libre sur la carte (acteurs créés sans token)`, 'warn');
    } catch {
      /* toasted */
    }
    setBusy(false);
  };

  if (isHost) {
    return html`<${Panel} title="Faire apparaître"><div class="bst-hint">Fiche de référence : fais apparaître les IC et les spiders du dossier Matrice à la place.</div></${Panel}>`;
  }
  return html`<${Panel} title="Faire apparaître">
    <div class="bst-spawn">
      <div class="field"><span class="field-label">Nombre</span><${NumberInput} value=${count} min=${1} max=${20} onChange=${setCount} /></div>
      <div class="field grow"><span class="field-label">Carte</span>
        <select class="input" value=${mapId} onChange=${(e) => setMapChoice(e.target.value)}>
          ${maps.map((m) => html`<option value=${m.id} selected=${m.id === mapId}>${m.name}${m.id === game.scene?.activeMapId ? ' (active)' : ''}</option>`)}
          <option value=${NO_MAP} selected=${mapId === NO_MAP}>— Aucune (fiches seulement) —</option>
        </select>
      </div>
      <div class="field"><span class="field-label">Visibilité</span><${Toggle} value=${hidden} onChange=${setHidden} label=${hidden ? 'Caché' : 'Visible'} /></div>
      ${combatOn && html`<div class="field"><span class="field-label">Combat</span><${Toggle} value=${addToCombat} onChange=${setAddToCombat} label="Ajouter" /></div>`}
      <${Button} variant="primary" disabled=${busy} onClick=${spawn}>☠ Faire apparaître</${Button}>
    </div>
    <div class="bst-hint" style=${{ marginTop: '6px' }}>
      ${map ? (anchor ? `Près du token sélectionné (${anchor.name}).` : 'Au centre de la carte (sélectionne un token sur la carte pour les placer à côté).') : 'Les PNJ seront créés sans token.'}
    </div>
  </${Panel}>`;
}

function SpawnedList({ game, t }) {
  const actors = Object.values(game.actors || {}).filter((a) => a.templateId === t.id);
  if (!actors.length) return null;
  const tokenOf = (actorId) => {
    for (const m of Object.values(game.maps || {})) {
      const tk = (m.tokens || []).find((x) => x.actorId === actorId);
      if (tk) return { map: m, token: tk };
    }
    return null;
  };
  const inCombat = (actorId) => (game.combat?.entries || []).some((e) => e.actorId === actorId);
  const addCombat = (a) => {
    const loc = tokenOf(a.id);
    send('combat/add', loc ? { tokenIds: [loc.token.id] } : { actorIds: [a.id] }).catch(() => null);
  };
  const saveAsTemplate = async (a) => {
    const name = await promptText('Nom du nouveau modèle', a.name.replace(/\s+\d+$/, ''));
    if (!name) return;
    send('bestiary/fromActor', { actorId: a.id, name, folder: t.folder }).then(() => toast('Modèle enregistré', 'success')).catch(() => null);
  };
  const remove = async (a) => {
    if (await confirmAction(`Supprimer définitivement ${a.name} (fiche et token) ?`)) send('actor/delete', { actorId: a.id }).catch(() => null);
  };
  return html`<${Panel} title=${`En jeu (${actors.length})`}>
    <div class="bst-spawned">
      ${actors.map((a) => {
        const d = safeDerive(a);
        const c = a.condition || {};
        const loc = tokenOf(a.id);
        return html`<div class="bst-spawned-row">
          <span class="grow"><strong>${a.name}</strong>
            ${d && html` <span class="mono small muted">P ${c.physical || 0}/${d.physicalMonitor} · É ${c.stun || 0}/${d.stunMonitor}</span>`}
            ${loc && html` <span class="faint small">· ${loc.map.name}</span>`}
          </span>
          ${a.hidden && html`<${Badge}>Caché</${Badge}>`}
          ${game.combat?.active && !inCombat(a.id) && html`<${Button} small onClick=${() => addCombat(a)}>+ Combat</${Button}>`}
          <${Button} small variant="ghost" onClick=${() => openSheet(a.id)}>Fiche</${Button}>
          <${Button} small variant="ghost" title="Enregistrer cette version comme nouveau modèle" onClick=${() => saveAsTemplate(a)}>→ Modèle</${Button}>
          <${Button} small variant="danger" title="Supprimer" onClick=${() => remove(a)}>✕</${Button}>
        </div>`;
      })}
    </div>
  </${Panel}>`;
}

export default function BestiaryPage({ game }) {
  const ui = useUI();
  const [folder, setFolder] = useState(null);
  const [q, setQ] = useState('');
  const [selId, setSelId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const fileRef = useRef(null);
  const isGM = game.me.role === 'gm';
  const bestiary = game.bestiary || {};
  const templates = useMemo(() => Object.values(bestiary).sort((a, b) => String(a.name).localeCompare(String(b.name), 'fr')), [bestiary]);

  const folders = useMemo(() => {
    const counts = {};
    for (const t of templates) counts[t.folder || 'Divers'] = (counts[t.folder || 'Divers'] || 0) + 1;
    return Object.keys(counts).sort(folderSort).map((name) => ({ name, count: counts[name] }));
  }, [templates]);

  const spawnedCount = useMemo(() => {
    const m = {};
    for (const a of Object.values(game.actors || {})) if (a.templateId) m[a.templateId] = (m[a.templateId] || 0) + 1;
    return m;
  }, [game.actors]);

  const filtered = useMemo(() => {
    const needle = norm(q.trim());
    return templates.filter((t) => {
      if (folder && (t.folder || 'Divers') !== folder) return false;
      if (!needle) return true;
      const hay = norm([t.name, t.concept, t.metatype, t.folder, (t.skills || []).map((s) => s.name).join(' '), (t.weapons || []).map((w) => w.name).join(' ')].join(' '));
      return needle.split(/\s+/).every((w) => hay.includes(w));
    });
  }, [templates, folder, q]);

  if (!isGM) return html`<div class="page"><${Empty}>Le bestiaire est réservé au MJ.</${Empty}></div>`;

  const selected = selId && bestiary[selId] ? bestiary[selId] : null;
  const editing = editingId && bestiary[editingId] ? bestiary[editingId] : null;

  const create = async () => {
    try {
      const res = await send('bestiary/create', { folder: folder || 'Divers' });
      setSelId(res.templateId);
      setEditingId(res.templateId);
    } catch {
      /* toasted */
    }
  };
  const duplicate = async (t) => {
    try {
      const res = await send('bestiary/duplicate', { templateId: t.id });
      setSelId(res.templateId);
      toast('Modèle dupliqué', 'success');
    } catch {
      /* toasted */
    }
  };
  const remove = async (t) => {
    const n = spawnedCount[t.id] || 0;
    const ok = await confirmAction(`Supprimer le modèle « ${t.name} » ?${n ? `\n(${n} PNJ déjà en jeu restent sur leurs cartes.)` : ''}`);
    if (!ok) return;
    send('bestiary/delete', { templateId: t.id })
      .then(() => setSelId(null))
      .catch(() => null);
  };
  const renameFolder = async (name) => {
    const to = await promptText(`Renommer le dossier « ${name} » en :`, name);
    if (!to || to === name) return;
    send('bestiary/renameFolder', { from: name, to })
      .then(() => {
        if (folder === name) setFolder(to);
      })
      .catch(() => null);
  };
  const exportList = () => {
    if (!filtered.length) return toast('Rien à exporter', 'warn');
    downloadJson(`bestiaire${folder ? '-' + norm(folder).replace(/[^a-z0-9]+/g, '-') : ''}.json`, filtered);
  };
  const importFile = async (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return toast('Fichier JSON illisible', 'error');
    }
    const list = Array.isArray(data) ? data : Array.isArray(data?.templates) ? data.templates : [data];
    try {
      const res = await send('bestiary/import', { templates: list });
      toast(`${res.count} modèle${res.count > 1 ? 's' : ''} importé${res.count > 1 ? 's' : ''}`, 'success');
      if (res.ids?.[0]) setSelId(res.ids[0]);
    } catch {
      /* toasted */
    }
  };
  const saveEdit = async (draft) => {
    await send('bestiary/update', { templateId: editing.id, patch: draft });
    toast('Modèle enregistré', 'success');
    setEditingId(null);
  };

  return html`<div class="page">
    <div class="page-title">
      <h2>Bestiaire</h2>
      <div class="row wrap">
        <${SearchBox} value=${q} onChange=${setQ} placeholder="Nom, compétence, arme…" />
        <${Button} variant="primary" onClick=${create}>+ Nouveau modèle</${Button}>
        <${Button} variant="ghost" title="Importer un fichier JSON de modèles" onClick=${() => fileRef.current?.click()}>Importer</${Button}>
        <${Button} variant="ghost" title="Exporter les modèles affichés en JSON" onClick=${exportList}>Exporter</${Button}>
        <input ref=${fileRef} type="file" accept=".json,application/json" style=${{ display: 'none' }} onChange=${importFile} />
      </div>
    </div>

    <div class=${'bst' + (selected ? ' has-sel' : '')}>
      <nav class="bst-side">
        <button class=${'bst-folder' + (!folder ? ' active' : '')} onClick=${() => setFolder(null)}>Tous<span class="count">${templates.length}</span></button>
        ${folders.map(
          (f) => html`<button class=${'bst-folder' + (folder === f.name ? ' active' : '')} onClick=${() => setFolder(f.name)}>
            <span>${f.name}</span>
            <span class="ren" title="Renommer le dossier" onClick=${(e) => {
              e.stopPropagation();
              renameFolder(f.name);
            }}>✎</span>
            <span class="count">${f.count}</span>
          </button>`
        )}
      </nav>

      <div class="bst-list">
        ${filtered.map((t) => html`<${TemplateCard} key=${t.id} t=${t} active=${selected?.id === t.id} spawned=${spawnedCount[t.id] || 0} onClick=${() => setSelId(t.id)} />`)}
        ${!filtered.length && html`<${Empty}>${templates.length ? 'Aucun modèle ne correspond.' : 'Bestiaire vide.'}</${Empty}>`}
      </div>

      <div class="bst-detail">
        ${selected
          ? html`
            <div class="bst-actions">
              <${Button} small variant="ghost" class="bst-back" onClick=${() => setSelId(null)}>← Liste</${Button}>
              <${Button} small variant="primary" onClick=${() => setEditingId(selected.id)}>Modifier</${Button}>
              <${Button} small onClick=${() => duplicate(selected)}>Dupliquer</${Button}>
              <${Button} small variant="ghost" onClick=${() => downloadJson(`${norm(selected.name).replace(/[^a-z0-9]+/g, '-') || 'modele'}.json`, selected)}>Exporter</${Button}>
              <${Button} small variant="ghost" onClick=${() => goTab('map')}>Voir la carte</${Button}>
              <span class="grow"></span>
              <${Button} small variant="danger" onClick=${() => remove(selected)}>Supprimer</${Button}>
            </div>
            <${SpawnBox} key=${'spawn-' + selected.id} game=${game} t=${selected} ui=${ui} />
            <${SpawnedList} game=${game} t=${selected} />
            <${StatBlock} t=${selected} />`
          : html`<${Panel} title="Bestiaire">
              <div class="col">
                <div class="muted">Choisis un modèle pour voir son bloc de stats, le faire apparaître sur une carte ou le modifier.</div>
                <div class="small faint">${templates.length} modèles · ${folders.length} dossiers · ${Object.values(spawnedCount).reduce((a, b) => a + b, 0)} PNJ en jeu</div>
              </div>
            </${Panel}>`}
      </div>
    </div>

    ${editing &&
    html`<${TemplateEditor} key=${editing.id} template=${editing} folders=${folders.map((f) => f.name)} onSave=${saveEdit} onClose=${() => setEditingId(null)} />`}
  </div>`;
}
