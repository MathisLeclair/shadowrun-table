// GM maps page: list grouped by folder (previews, active badge, create / import / export / duplicate / delete)
// and the full editor (editor.js) for the selected map.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { html, Button, Badge, Empty, Modal, Field, Select, SearchBox, NumberInput, loadCss, confirmAction } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { useUI, setUI, getUI, toast } from '../../lib/ui-store.js';
import { themeOptions, lightingOptions, themeLabel, lightingLabel, renderThumbnail, isImageMap, wallsKey } from './renderer.js';
import { t, compare, getLang } from '../../lib/i18n.js';

const byName = (a, b) => String(a).localeCompare(String(b), getLang(), { numeric: true });
import { MapEditor } from './editor.js';

loadCss('/modules/map/map.css');

const quiet = () => {};
/** Like Field but a <div>: a <label> would forward clicks on its text to the stepper buttons. */
const NumField = ({ label, children }) => html`<div class="field"><span class="field-label">${label}</span>${children}</div>`;

function download(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function exportMap(map) {
  const { explored, ...rest } = map;
  const clean = { ...rest, tokens: (rest.tokens || []).map(({ lastMove, ...t }) => t) };
  const file = (map.name || t('carte')).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-').toLowerCase();
  download(`${file || t('carte')}.json`, clean);
}

export default function MapsPage({ game }) {
  const ui = useUI();
  const maps = game.maps || {};
  const editing = ui.mapsEditId && maps[ui.mapsEditId] ? maps[ui.mapsEditId] : null;
  if (editing) return html`<${MapEditor} key=${editing.id} game=${game} map=${editing} onBack=${() => setUI({ mapsEditId: null })} />`;
  return html`<${MapsList} game=${game} />`;
}

function MapsList({ game }) {
  const maps = game.maps || {};
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const fileRef = useRef(null);
  const activeId = game.scene?.activeMapId;

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = Object.values(maps)
      .filter((m) => !needle || `${m.name} ${m.folder || ''}`.toLowerCase().includes(needle))
      .sort((a, b) => byName(a.name, b.name));
    const by = new Map();
    // '' = maps without a folder (listed last, shown as « Sans dossier »).
    for (const m of list) {
      const f = m.folder || '';
      if (!by.has(f)) by.set(f, []);
      by.get(f).push(m);
    }
    return [...by.entries()].sort((a, b) => (a[0] === '') - (b[0] === '') || byName(a[0], b[0]));
  }, [maps, q]);

  const onImport = async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    for (const f of files) {
      try {
        const data = JSON.parse(await f.text());
        const list = Array.isArray(data) ? data : [data];
        for (const m of list) {
          const id = await send('maps/import', { map: m });
          toast(t('Carte importée : {name}', { name: maps[id]?.name || m.name || f.name }), 'success');
        }
      } catch (err) {
        toast(t('Import impossible ({file}) : {error}', { file: f.name, error: err.message }), 'error');
      }
    }
  };

  return html`<div class="page">
    <div class="page-title">
      <h2>${t('Cartes')}</h2>
      <div class="row wrap">
        <${SearchBox} value=${q} onChange=${setQ} placeholder=${t('Rechercher une carte…')} />
        <${Button} onClick=${() => fileRef.current?.click()}>${t('Importer…')}</${Button}>
        <input type="file" accept=".json,application/json" multiple hidden ref=${fileRef} onChange=${onImport} />
        <${Button} variant="primary" onClick=${() => setCreating(true)}>${t('+ Nouvelle carte')}</${Button}>
      </div>
    </div>
    <div class="row wrap small muted" style=${{ marginBottom: '4px' }}>
      ${t('Carte affichée aux joueurs :')} <strong class="green">${maps[activeId]?.name || t('aucune')}</strong>
      ${activeId && html`<${Button} small variant="ghost" onClick=${() => send('maps/setActive', { mapId: null }).catch(quiet)}>${t('Masquer la carte')}</${Button}>`}
    </div>
    ${!Object.keys(maps).length && html`<${Empty}>${t("Aucune carte pour l'instant. Crée-en une ou importe un fichier JSON.")}</${Empty}>`}
    ${groups.map(
      ([folder, list]) => html`<div class="maps-folder">
        <div class="section-title">${folder || t('Sans dossier')} <span class="muted">(${list.length})</span></div>
        <div class="maps-grid">${list.map((m) => html`<${MapCard} key=${m.id} map=${m} active=${m.id === activeId} />`)}</div>
      </div>`
    )}
    ${creating && html`<${CreateMapModal} game=${game} onClose=${() => setCreating(false)} />`}
  </div>`;
}

function MapCard({ map, active }) {
  const ref = useRef(null);
  const bg = map.background;
  const sig = `${map.width}x${map.height}|${map.theme}|${map.tiles.join('')}|${(map.doors || []).map((d) => d.state + d.kind).join()}|${(map.tokens || []).map((t) => t.x + ',' + t.y + t.disposition).join()}|${bg ? `${bg.url}${bg.mode}${bg.x},${bg.y},${bg.w},${bg.h},${bg.opacity}` : ''}|${wallsKey(map)}`;
  const walls = map.walls || [];
  const wallDoors = walls.filter((w) => w.door).length;
  useEffect(() => {
    if (ref.current) renderThumbnail(ref.current, map, 240);
  }, [sig]);
  const edit = () => setUI({ mapsEditId: map.id });
  const del = async () => {
    if (!(await confirmAction(t('Supprimer définitivement la carte « {name} » ?', { name: map.name }) + (active ? '\n' + t('Elle est actuellement affichée aux joueurs.') : '')))) return;
    send('maps/delete', { mapId: map.id }).then(() => {
      toast(t('Carte supprimée'));
      const u = getUI();
      if (u.viewMapId === map.id) setUI({ viewMapId: null });
      if (u.mapsEditId === map.id) setUI({ mapsEditId: null });
    }, quiet);
  };
  const dup = () => send('maps/duplicate', { mapId: map.id }).then(() => toast(t('Carte dupliquée'), 'success'), quiet);
  return html`<div class=${'maps-card' + (active ? ' active' : '')}>
    <div class="maps-thumb" onClick=${edit} title=${t('Éditer')}>
      <canvas ref=${ref}></canvas>
      ${active && html`<${Badge} color="green">● ${t('Affichée')}</${Badge}>`}
    </div>
    <div class="maps-card-body">
      <h4>${map.name}</h4>
      <div class="row wrap small muted">
        <span>${map.width} × ${map.height}</span>·<span>${themeLabel(map.theme)}</span>·<span>${lightingLabel(map.lighting)}</span>
        ${(map.tokens || []).length ? html`·<span>${t('{n} pion(s)', { n: map.tokens.length })}</span>` : null}
        ${map.fog === false ? html`·<span class="amber">${t('sans brouillard')}</span>` : null}
        ${isImageMap(map) ? html`·<span class="cyan" title=${t("Carte illustrée : l'image sert de sol")}>${t('illustrée')}</span>` : null}
        ${walls.length ? html`·<span title=${t('Murs en segments')}>${wallDoors ? t('{walls} mur(s), {doors} porte(s)', { walls: walls.length, doors: wallDoors }) : t('{n} mur(s)', { n: walls.length })}</span>` : null}
        ${map.foundry ? html`·<span class="magenta" title=${t('Importée de Foundry VTT')}>Foundry</span>` : null}
      </div>
    </div>
    <div class="maps-card-actions">
      <${Button} small variant="primary" onClick=${edit}>${t('Éditer')}</${Button}>
      ${active
        ? html`<${Button} small onClick=${() => setUI({ viewMapId: map.id, mainTab: 'map' })}>${t('Voir en jeu')}</${Button}>`
        : html`<${Button} small variant="accent" onClick=${() => send('maps/setActive', { mapId: map.id }).then(() => toast(t('Carte affichée aux joueurs'), 'success'), quiet)}>${t('Afficher')}</${Button}>`}
      <${Button} small variant="ghost" onClick=${dup}>${t('Dupliquer')}</${Button}>
      <${Button} small variant="ghost" onClick=${() => exportMap(map)}>${t('Exporter')}</${Button}>
      <${Button} small variant="ghost" onClick=${del} title=${t('Supprimer')}>✕</${Button}>
    </div>
  </div>`;
}

function CreateMapModal({ game, onClose }) {
  const folders = [...new Set(Object.values(game.maps || {}).map((m) => m.folder).filter(Boolean))].sort(compare);
  const [f, setF] = useState({ name: '', folder: folders[0] || '', width: 30, height: 20, theme: 'street', lighting: 'bright', fill: '.' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF((o) => ({ ...o, [k]: v }));
  const submit = async (e) => {
    e?.preventDefault?.();
    if (busy) return;
    setBusy(true);
    try {
      const id = await send('maps/create', { ...f, name: f.name.trim() || t('Nouvelle carte') });
      onClose();
      setUI({ mapsEditId: id });
    } catch {
      setBusy(false);
    }
  };
  return html`<${Modal} title=${t('Nouvelle carte')} width=${520} onClose=${onClose}
    actions=${html`<${Button} variant="primary" disabled=${busy} onClick=${submit}>${t('Créer et éditer')}</${Button}>`}>
    <form class="col" onSubmit=${submit}>
      <${Field} label=${t('Nom')}><input class="input" value=${f.name} placeholder=${t('ex. Entrepôt de Tacoma')} autofocus onInput=${(e) => set('name')(e.target.value)} /></${Field}>
      <${Field} label=${t('Dossier')} hint=${t('Regroupe les cartes (ex. Acte 1, Lieux récurrents)')}>
        <input class="input" list="maps-folders" value=${f.folder} onInput=${(e) => set('folder')(e.target.value)} />
        <datalist id="maps-folders">${folders.map((x) => html`<option value=${x} />`)}</datalist>
      </${Field}>
      <div class="grid-2">
        <${NumField} label=${t('Largeur (cases)')}><${NumberInput} value=${f.width} min=${4} max=${160} onChange=${set('width')} /></${NumField}>
        <${NumField} label=${t('Hauteur (cases)')}><${NumberInput} value=${f.height} min=${4} max=${160} onChange=${set('height')} /></${NumField}>
        <${Field} label=${t('carte::Ambiance')}><${Select} value=${f.theme} options=${themeOptions()} onChange=${set('theme')} /></${Field}>
        <${Field} label=${t('Éclairage')}><${Select} value=${f.lighting} options=${lightingOptions()} onChange=${set('lighting')} /></${Field}>
      </div>
      <${Field} label=${t('Départ')}>
        <${Select} value=${f.fill} onChange=${set('fill')} options=${[
          { value: '.', label: t('Intérieur : sol entouré de murs') },
          { value: ',', label: t('Extérieur : rue / terrain entouré de murs') },
          { value: ' ', label: t('Vide (tout dessiner)') },
          { value: 'image', label: t('Carte illustrée : sol partout, image + murs en segments') },
        ]} />
      </${Field}>
      <span class="small muted">${t("1 case = 1 mètre par défaut (modifiable dans l'éditeur).")}</span>
      <button type="submit" hidden></button>
    </form>
  </${Modal}>`;
}
