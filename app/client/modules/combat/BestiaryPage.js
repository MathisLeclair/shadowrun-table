// Bestiary (GM): NPC templates by folder, SR5 stat blocks, spawn onto maps, editor, import/export.
import { useState, useMemo, useRef } from 'preact/hooks';
import { html, Button, Badge, Empty, Panel, NumberInput, Toggle, SearchBox, loadCss, confirmAction, promptText } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { useUI, openSheet, toast, goTab } from '../../lib/ui-store.js';
import { t, tn, metatypeLabel, compare } from '../../lib/i18n.js';
import { initials, avatarStyle, safeDerive, downloadJson, npcKindLabel } from './combat-common.js';
import StatBlock from './StatBlock.js';
import TemplateEditor from './TemplateEditor.js';
import EnemyGenerator from '../chargen/EnemyGenerator.js';

loadCss('/modules/combat/combat.css');

const FOLDER_ORDER = ['Project Lazarus', 'Gangs', 'Sécurité corpo', 'Spécialistes', 'Matrice', 'Créatures'];
const NO_MAP = '__none';
const DEFAULT_FOLDER = 'Divers'; // stored default folder name (server side), shown translated

const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Folder name to display (the server's default folder is translated, GM folders are shown as typed). */
const folderLabel = (name) => (name === DEFAULT_FOLDER ? t('Divers') : name);

function folderSort(a, b) {
  const ia = FOLDER_ORDER.indexOf(a);
  const ib = FOLDER_ORDER.indexOf(b);
  if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  return a.localeCompare(b, 'fr');
}

function TemplateCard({ tpl, active, spawned, onClick }) {
  const d = safeDerive(tpl);
  const kind = tpl.npc?.kind || 'metahuman';
  return html`<div class=${'bst-card' + (active ? ' active' : '')} style=${{ '--tc': tpl.color || 'var(--magenta)' }} onClick=${onClick}>
    <div class="bst-card-top">
      <strong title=${tpl.name}>${tpl.name}</strong>
      ${spawned > 0 && html`<${Badge} color="green" title=${t('PNJ de ce modèle actuellement en jeu')}>×${spawned}</${Badge}>`}
    </div>
    <div class="sub">${[tpl.metatype && metatypeLabel(tpl.metatype), tpl.concept].filter(Boolean).join(' · ') || '—'}</div>
    <div class="meta">
      ${tpl.npc?.professionalRating > 0 && html`<${Badge} color="amber">${t('PR {n}', { n: tpl.npc.professionalRating })}</${Badge}>`}
      ${tpl.npc?.grunt && html`<${Badge} color="magenta">${t('Sbire')}</${Badge}>`}
      ${kind !== 'metahuman' && html`<${Badge} color="cyan">${npcKindLabel(kind)}</${Badge}>`}
      ${d && kind !== 'host' && html`<span class="mono small muted">${t('Init {text}', { text: d.initiative.text })}</span>`}
    </div>
  </div>`;
}

/** Toast text after a spawn (whole sentences, one per case). */
function spawnMessage(n, mapName, hidden) {
  const p = { map: mapName };
  if (mapName && hidden) return tn(n, '{n} PNJ créé sur « {map} » (cachés)', '{n} PNJ créés sur « {map} » (cachés)', p);
  if (mapName) return tn(n, '{n} PNJ créé sur « {map} »', '{n} PNJ créés sur « {map} »', p);
  if (hidden) return tn(n, '{n} PNJ créé (cachés)', '{n} PNJ créés (cachés)');
  return tn(n, '{n} PNJ créé', '{n} PNJ créés');
}

function SpawnBox({ game, tpl, ui }) {
  const maps = Object.values(game.maps || {}).sort((a, b) => compare(a.name, b.name));
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
  const isHost = tpl.npc?.kind === 'host';

  const spawn = async () => {
    setBusy(true);
    try {
      const payload = { templateId: tpl.id, count, hidden, mapId: map ? map.id : null, addToCombat: combatOn && addToCombat };
      if (anchor) {
        payload.x = anchor.x;
        payload.y = anchor.y;
      }
      const res = await send('bestiary/spawn', payload);
      toast(spawnMessage(res.actorIds.length, map ? map.name : '', hidden), 'success');
      if (res.unplaced) toast(t('{n} PNJ sans place libre sur la carte (acteurs créés sans token)', { n: res.unplaced }), 'warn');
    } catch {
      /* toasted */
    }
    setBusy(false);
  };

  if (isHost) {
    return html`<${Panel} title=${t('Faire apparaître')}><div class="bst-hint">${t('Fiche de référence : fais apparaître les IC et les spiders du dossier Matrice à la place.')}</div></${Panel}>`;
  }
  return html`<${Panel} title=${t('Faire apparaître')}>
    <div class="bst-spawn">
      <div class="field"><span class="field-label">${t('Nombre')}</span><${NumberInput} value=${count} min=${1} max=${20} onChange=${setCount} /></div>
      <div class="field grow"><span class="field-label">${t('Carte')}</span>
        <select class="input" value=${mapId} onChange=${(e) => setMapChoice(e.target.value)}>
          ${maps.map((m) => html`<option value=${m.id} selected=${m.id === mapId}>${m.id === game.scene?.activeMapId ? t('{name} (active)', { name: m.name }) : m.name}</option>`)}
          <option value=${NO_MAP} selected=${mapId === NO_MAP}>${t('— Aucune (fiches seulement) —')}</option>
        </select>
      </div>
      <div class="field"><span class="field-label">${t('Visibilité')}</span><${Toggle} value=${hidden} onChange=${setHidden} label=${hidden ? t('Caché') : t('Visible')} /></div>
      ${combatOn && html`<div class="field"><span class="field-label">${t('Combat')}</span><${Toggle} value=${addToCombat} onChange=${setAddToCombat} label=${t('Ajouter')} /></div>`}
      <${Button} variant="primary" disabled=${busy} onClick=${spawn}>☠ ${t('Faire apparaître')}</${Button}>
    </div>
    <div class="bst-hint" style=${{ marginTop: '6px' }}>
      ${map ? (anchor ? t('Près du token sélectionné ({name}).', { name: anchor.name }) : t('Au centre de la carte (sélectionne un token sur la carte pour les placer à côté).')) : t('Les PNJ seront créés sans token.')}
    </div>
  </${Panel}>`;
}

function SpawnedList({ game, tpl }) {
  const actors = Object.values(game.actors || {}).filter((a) => a.templateId === tpl.id);
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
    const name = await promptText(t('Nom du nouveau modèle'), a.name.replace(/\s+\d+$/, ''));
    if (!name) return;
    send('bestiary/fromActor', { actorId: a.id, name, folder: tpl.folder }).then(() => toast(t('Modèle enregistré'), 'success')).catch(() => null);
  };
  const remove = async (a) => {
    if (await confirmAction(t('Supprimer définitivement {name} (fiche et token) ?', { name: a.name }))) send('actor/delete', { actorId: a.id }).catch(() => null);
  };
  return html`<${Panel} title=${t('En jeu ({n})', { n: actors.length })}>
    <div class="bst-spawned">
      ${actors.map((a) => {
        const d = safeDerive(a);
        const c = a.condition || {};
        const loc = tokenOf(a.id);
        return html`<div class="bst-spawned-row">
          <span class="grow"><strong>${a.name}</strong>
            ${d && html` <span class="mono small muted">${t('P {p}/{pmax} · É {s}/{smax}', { p: c.physical || 0, pmax: d.physicalMonitor, s: c.stun || 0, smax: d.stunMonitor })}</span>`}
            ${loc && html` <span class="faint small">· ${loc.map.name}</span>`}
          </span>
          ${a.hidden && html`<${Badge}>${t('Caché')}</${Badge}>`}
          ${game.combat?.active && !inCombat(a.id) && html`<${Button} small onClick=${() => addCombat(a)}>${t('+ Combat')}</${Button}>`}
          <${Button} small variant="ghost" onClick=${() => openSheet(a.id)}>${t('Fiche')}</${Button}>
          <${Button} small variant="ghost" title=${t('Enregistrer cette version comme nouveau modèle')} onClick=${() => saveAsTemplate(a)}>${t('→ Modèle')}</${Button}>
          <${Button} small variant="danger" title=${t('Supprimer')} onClick=${() => remove(a)}>✕</${Button}>
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
  const [genOpen, setGenOpen] = useState(false);
  const fileRef = useRef(null);
  const isGM = game.me.role === 'gm';
  const bestiary = game.bestiary || {};
  const templates = useMemo(() => Object.values(bestiary).sort((a, b) => String(a.name).localeCompare(String(b.name), 'fr')), [bestiary]);

  const folders = useMemo(() => {
    const counts = {};
    for (const tpl of templates) counts[tpl.folder || DEFAULT_FOLDER] = (counts[tpl.folder || DEFAULT_FOLDER] || 0) + 1;
    return Object.keys(counts).sort(folderSort).map((name) => ({ name, count: counts[name] }));
  }, [templates]);

  const spawnedCount = useMemo(() => {
    const m = {};
    for (const a of Object.values(game.actors || {})) if (a.templateId) m[a.templateId] = (m[a.templateId] || 0) + 1;
    return m;
  }, [game.actors]);

  const filtered = useMemo(() => {
    const needle = norm(q.trim());
    return templates.filter((tpl) => {
      if (folder && (tpl.folder || DEFAULT_FOLDER) !== folder) return false;
      if (!needle) return true;
      const hay = norm([tpl.name, tpl.concept, tpl.metatype, tpl.folder, (tpl.skills || []).map((s) => s.name).join(' '), (tpl.weapons || []).map((w) => w.name).join(' ')].join(' '));
      return needle.split(/\s+/).every((w) => hay.includes(w));
    });
  }, [templates, folder, q]);

  if (!isGM) return html`<div class="page"><${Empty}>${t('Le bestiaire est réservé au MJ.')}</${Empty}></div>`;

  const selected = selId && bestiary[selId] ? bestiary[selId] : null;
  const editing = editingId && bestiary[editingId] ? bestiary[editingId] : null;

  const create = async () => {
    try {
      const res = await send('bestiary/create', { folder: folder || DEFAULT_FOLDER });
      setSelId(res.templateId);
      setEditingId(res.templateId);
    } catch {
      /* toasted */
    }
  };
  const duplicate = async (tpl) => {
    try {
      const res = await send('bestiary/duplicate', { templateId: tpl.id });
      setSelId(res.templateId);
      toast(t('Modèle dupliqué'), 'success');
    } catch {
      /* toasted */
    }
  };
  const remove = async (tpl) => {
    const n = spawnedCount[tpl.id] || 0;
    const ok = await confirmAction(n
      ? t('Supprimer le modèle « {name} » ?\n({n} PNJ déjà en jeu restent sur leurs cartes.)', { name: tpl.name, n })
      : t('Supprimer le modèle « {name} » ?', { name: tpl.name }));
    if (!ok) return;
    send('bestiary/delete', { templateId: tpl.id })
      .then(() => setSelId(null))
      .catch(() => null);
  };
  const renameFolder = async (name) => {
    const to = await promptText(t('Renommer le dossier « {name} » en :', { name: folderLabel(name) }), name);
    if (!to || to === name) return;
    send('bestiary/renameFolder', { from: name, to })
      .then(() => {
        if (folder === name) setFolder(to);
      })
      .catch(() => null);
  };
  const exportList = () => {
    if (!filtered.length) return toast(t('Rien à exporter'), 'warn');
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
      return toast(t('Fichier JSON illisible'), 'error');
    }
    const list = Array.isArray(data) ? data : Array.isArray(data?.templates) ? data.templates : [data];
    try {
      const res = await send('bestiary/import', { templates: list });
      toast(tn(res.count, '{n} modèle importé', '{n} modèles importés'), 'success');
      if (res.ids?.[0]) setSelId(res.ids[0]);
    } catch {
      /* toasted */
    }
  };
  const saveEdit = async (draft) => {
    await send('bestiary/update', { templateId: editing.id, patch: draft });
    toast(t('Modèle enregistré'), 'success');
    setEditingId(null);
  };

  return html`<div class="page">
    <div class="page-title">
      <h2>${t('Bestiaire')}</h2>
      <div class="row wrap">
        <${SearchBox} value=${q} onChange=${setQ} placeholder=${t('Nom, compétence, arme…')} />
        <${Button} variant="accent" onClick=${() => setGenOpen(true)}>☠ ${t('Créer un ennemi')}</${Button}>
        <${Button} variant="primary" onClick=${create}>${t('+ Nouveau modèle')}</${Button}>
        <${Button} variant="ghost" title=${t('Importer un fichier JSON de modèles')} onClick=${() => fileRef.current?.click()}>${t('Importer')}</${Button}>
        <${Button} variant="ghost" title=${t('Exporter les modèles affichés en JSON')} onClick=${exportList}>${t('Exporter')}</${Button}>
        <input ref=${fileRef} type="file" accept=".json,application/json" style=${{ display: 'none' }} onChange=${importFile} />
      </div>
    </div>

    <div class=${'bst' + (selected ? ' has-sel' : '')}>
      <nav class="bst-side">
        <button class=${'bst-folder' + (!folder ? ' active' : '')} onClick=${() => setFolder(null)}>${t('Tous')}<span class="count">${templates.length}</span></button>
        ${folders.map(
          (f) => html`<button class=${'bst-folder' + (folder === f.name ? ' active' : '')} onClick=${() => setFolder(f.name)}>
            <span>${folderLabel(f.name)}</span>
            <span class="ren" title=${t('Renommer le dossier')} onClick=${(e) => {
              e.stopPropagation();
              renameFolder(f.name);
            }}>✎</span>
            <span class="count">${f.count}</span>
          </button>`
        )}
      </nav>

      <div class="bst-list">
        ${filtered.map((tpl) => html`<${TemplateCard} key=${tpl.id} tpl=${tpl} active=${selected?.id === tpl.id} spawned=${spawnedCount[tpl.id] || 0} onClick=${() => setSelId(tpl.id)} />`)}
        ${!filtered.length && html`<${Empty}>${templates.length ? t('Aucun modèle ne correspond.') : t('Bestiaire vide.')}</${Empty}>`}
      </div>

      <div class="bst-detail">
        ${selected
          ? html`
            <div class="bst-actions">
              <${Button} small variant="ghost" class="bst-back" onClick=${() => setSelId(null)}>${t('← Liste')}</${Button}>
              <${Button} small variant="primary" onClick=${() => setEditingId(selected.id)}>${t('Modifier')}</${Button}>
              <${Button} small onClick=${() => duplicate(selected)}>${t('Dupliquer')}</${Button}>
              <${Button} small variant="ghost" onClick=${() => downloadJson(`${norm(selected.name).replace(/[^a-z0-9]+/g, '-') || 'modele'}.json`, selected)}>${t('Exporter')}</${Button}>
              <${Button} small variant="ghost" onClick=${() => goTab('map')}>${t('Voir la carte')}</${Button}>
              <span class="grow"></span>
              <${Button} small variant="danger" onClick=${() => remove(selected)}>${t('Supprimer')}</${Button}>
            </div>
            <${SpawnBox} key=${'spawn-' + selected.id} game=${game} tpl=${selected} ui=${ui} />
            <${SpawnedList} game=${game} tpl=${selected} />
            <${StatBlock} t=${selected} />`
          : html`<${Panel} title=${t('Bestiaire')}>
              <div class="col">
                <div class="muted">${t('Choisis un modèle pour voir son bloc de stats, le faire apparaître sur une carte ou le modifier.')}</div>
                <div class="small faint">${t('{templates} modèles · {folders} dossiers · {npcs} PNJ en jeu', { templates: templates.length, folders: folders.length, npcs: Object.values(spawnedCount).reduce((a, b) => a + b, 0) })}</div>
              </div>
            </${Panel}>`}
      </div>
    </div>

    ${genOpen && html`<${EnemyGenerator} game=${game} onClose=${() => setGenOpen(false)} onCreated=${(res) => res.templateIds?.[0] && setSelId(res.templateIds[0])} />`}
    ${editing &&
    html`<${TemplateEditor} key=${editing.id} template=${editing} folders=${folders.map((f) => f.name)} onSave=${saveEdit} onClose=${() => setEditingId(null)} />`}
  </div>`;
}
