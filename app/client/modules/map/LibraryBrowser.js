// GM « Bibliothèque » tab of the Cartes page (server-wide map library, see ARCHITECTURE.md « Map library »):
// thumbnails with search (French / English names, tags) and filters, a preview (walls over the image, real renderer),
// « Ajouter à cette table » → maps/fromLibrary. Also the dialog of a library-linked table map: diff with the library,
// « Mettre à jour depuis la bibliothèque », « Publier mes corrections dans la bibliothèque », « Détacher ».
import { useEffect, useMemo, useState } from 'preact/hooks';
import { html, Button, Badge, Empty, Modal, Field, Select, SearchBox, confirmAction } from '../../lib/ui.js';
import { send, api } from '../../lib/net.js';
import { toast } from '../../lib/ui-store.js';
import { t, tn, tk, getLang, fmtDate } from '../../lib/i18n.js';
import { uid } from '/shared/util.js';
import { libGeometry, instanceContent, libImageUrl, matchesQuery } from '/shared/maplib.js';
import { MapCanvas } from './MapCanvas.js';
import { themeOptions, themeLabel, lightingLabel } from './renderer.js';
import { useLibKey, signedUrl, useLibrary, loadLibrary } from './maplib-client.js';

const quiet = () => {};
const SOURCES = { fragmap: tk('Fragmaps (Patreon)'), 'fragmaps-free': tk('Fragmaps (gratuites)') };
const QUALITY = { good: tk('Murs soignés'), rough: tk('Murs approximatifs') };
/** Display name in the UI language (English file name / natural French name). */
export const libName = (e) => (getLang() === 'en' ? e.name || e.nameFr : e.nameFr || e.name) || e.slug;

/** Table map (Map schema) built from a library map, for the preview only (nothing is sent). */
function previewMap(full) {
  const g = libGeometry({ ...full, ...(full.geometry || {}) });
  const c = instanceContent(full, uid);
  return {
    id: `preview_${full.slug}_${full.version}`, name: libName(full), width: g.width, height: g.height, metersPerCell: full.metersPerCell,
    tiles: Array.from({ length: g.height }, () => '.'.repeat(g.width)), doors: [], notes: [], tokens: [], explored: {}, fog: false,
    lighting: 'bright', theme: full.theme, walls: c.walls, lights: c.lights, regions: c.regions,
    background: { url: libImageUrl(full.slug), opacity: 1, mode: 'image', x: g.bgX, y: g.bgY, w: g.bgW, h: g.bgH },
  };
}

function AddForm({ entry, game, onAdded }) {
  const folders = [...new Set(Object.values(game.maps || {}).map((m) => m.folder).filter(Boolean))].sort();
  const [name, setName] = useState(libName(entry));
  const [folder, setFolder] = useState(t('Bibliothèque'));
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      const id = await send('maps/fromLibrary', { slug: entry.slug, name: name.trim(), folder: folder.trim() });
      toast(t('Carte ajoutée à la table : {name}', { name: name.trim() || libName(entry) }), 'success');
      onAdded?.(id);
    } catch {
      setBusy(false);
    }
  };
  return html`<div class="col gap-s">
    <${Field} label=${t('Nom dans la table')}><input class="input" value=${name} onInput=${(e) => setName(e.target.value)} /></${Field}>
    <${Field} label=${t('Dossier')}>
      <input class="input" list="maplib-folders" value=${folder} onInput=${(e) => setFolder(e.target.value)} />
      <datalist id="maplib-folders">${folders.map((f) => html`<option value=${f} />`)}</datalist>
    </${Field}>
    <${Button} variant="primary" disabled=${busy} onClick=${add}>${t('Ajouter à cette table')}</${Button}>
    <span class="small muted">${t('La table reçoit sa propre copie : pions, brouillard, portes et retouches restent dans cette table.')}</span>
  </div>`;
}

function PreviewModal({ entry, game, onClose, onAdded }) {
  const [full, setFull] = useState(null);
  const [err, setErr] = useState(null);
  const [showWalls, setShowWalls] = useState(true);
  useEffect(() => {
    api(`/api/maplib/${encodeURIComponent(entry.slug)}`).then(setFull, setErr);
  }, [entry.slug]);
  const map = useMemo(() => (full ? previewMap(full) : null), [full]);
  const scene = useMemo(
    () => map && ({
      map, actors: {}, role: 'gm', me: game.me, selected: new Set(), turnTokenId: null, gmLayer: true, editor: false,
      fog: null, unseen: null, tokenMask: null, darkFactor: 0.55, showWalls, showGrid: true, barsFor: () => false,
    }),
    [map, showWalls]
  );
  return html`<${Modal} title=${libName(entry)} width=${1100} onClose=${onClose}>
    <div class="maplib-preview">
      <div class="maplib-preview-canvas">
        ${err ? html`<${Empty}>${err.message}</${Empty}>` : scene ? html`<${MapCanvas} scene=${scene} handlers=${{}} />` : html`<${Empty}>${t('Chargement…')}</${Empty}>`}
      </div>
      <aside class="maplib-preview-side col gap-s">
        <div class="row wrap gap-s">
          <${Badge} color="cyan">${t(SOURCES[entry.source] || entry.source)}</${Badge}>
          <${Badge} color=${entry.quality === 'good' ? 'green' : 'amber'}>${t(QUALITY[entry.quality] || QUALITY.rough)}</${Badge}>
          ${!entry.hasImage && html`<${Badge} color="red">${t('Image manquante sur le serveur')}</${Badge}>`}
        </div>
        ${getLang() === 'en' ? null : html`<div class="small muted">${entry.name}</div>`}
        <p class="small">${entry.description || t('Pas de description.')}</p>
        <div class="small muted">
          ${t('{w} × {h} cases · {m} m par case', { w: entry.width, h: entry.height, m: entry.metersPerCell })}<br />
          ${themeLabel(entry.theme)} · ${lightingLabel(entry.lighting)}<br />
          ${entry.counts ? t('{walls} murs, {doors} portes, {lights} lumières, {regions} zones', entry.counts) : null}<br />
          ${t('Version {v}', { v: entry.version })}${entry.updatedAt ? ` · ${fmtDate(entry.updatedAt)}` : ''}
        </div>
        ${entry.tags?.length ? html`<div class="row wrap gap-s">${entry.tags.slice(0, 16).map((x) => html`<span class="maplib-tag">${x}</span>`)}</div>` : null}
        <label class="row gap-s small"><input type="checkbox" checked=${showWalls} onChange=${(e) => setShowWalls(e.target.checked)} /> ${t('Afficher les murs')}</label>
        <hr />
        <${AddForm} entry=${entry} game=${game} onAdded=${(id) => { onClose(); onAdded?.(id); }} />
      </aside>
    </div>
  </${Modal}>`;
}

function LibCard({ entry, k, uses, onPreview, game, onAdded }) {
  const src = entry.hasThumb || !entry.hasImage ? signedUrl(entry.thumb, k) : null;
  const [adding, setAdding] = useState(false);
  return html`<div class="maps-card maplib-card">
    <div class="maps-thumb" onClick=${onPreview} title=${t('Aperçu')}>
      ${src ? html`<img src=${src} alt="" loading="lazy" />` : html`<span class="muted small">${libName(entry)}</span>`}
      ${uses ? html`<${Badge} color="green">${tn(uses, '{n} copie sur la table', '{n} copies sur la table')}</${Badge}>` : null}
    </div>
    <div class="maps-card-body">
      <h4>${libName(entry)}</h4>
      <div class="row wrap small muted">
        <span>${entry.width} × ${entry.height}</span>·<span>${themeLabel(entry.theme)}</span>·
        <span class=${entry.quality === 'good' ? 'green' : 'amber'}>${t(QUALITY[entry.quality] || QUALITY.rough)}</span>
        ${entry.source === 'fragmaps-free' ? html`·<span class="magenta">${t('gratuite')}</span>` : null}
      </div>
    </div>
    <div class="maps-card-actions">
      <${Button} small variant="primary" disabled=${adding} onClick=${async () => {
        setAdding(true);
        try {
          const id = await send('maps/fromLibrary', { slug: entry.slug });
          toast(t('Carte ajoutée à la table : {name}', { name: libName(entry) }), 'success');
          onAdded?.(id);
        } catch {}
        setAdding(false);
      }}>${t('Ajouter à cette table')}</${Button}>
      <${Button} small variant="ghost" onClick=${onPreview}>${t('Aperçu')}</${Button}>
    </div>
  </div>`;
}

/** Library browser (GM). onAdded(mapId) after « Ajouter à cette table ». */
export function LibraryBrowser({ game, onAdded }) {
  const { data, error } = useLibrary();
  const k = useLibKey();
  const [q, setQ] = useState('');
  const [theme, setTheme] = useState('');
  const [source, setSource] = useState('');
  const [quality, setQuality] = useState('');
  const [preview, setPreview] = useState(null);
  const uses = useMemo(() => {
    const out = {};
    for (const m of Object.values(game.maps || {})) if (m.library?.slug) out[m.library.slug] = (out[m.library.slug] || 0) + 1;
    return out;
  }, [game.maps]);
  const list = useMemo(
    () => (data?.maps || [])
      .filter((e) => (!theme || e.theme === theme) && (!source || e.source === source) && (!quality || e.quality === quality) && matchesQuery(e, q))
      .sort((a, b) => libName(a).localeCompare(libName(b), getLang(), { numeric: true })),
    [data, q, theme, source, quality]
  );
  if (error) return html`<${Empty}>${error.message}</${Empty}>`;
  if (!data) return html`<${Empty}>${t('Chargement…')}</${Empty}>`;
  return html`<div class="col gap-s">
    <div class="row wrap gap-s maplib-filters">
      <${SearchBox} value=${q} onChange=${setQ} placeholder=${t('Rechercher : nom, lieu, ambiance…')} />
      <${Select} value=${theme} onChange=${setTheme} options=${[{ value: '', label: t('Toutes les ambiances') }, ...themeOptions()]} />
      <${Select} value=${source} onChange=${setSource} options=${[{ value: '', label: t('Toutes les sources') }, ...Object.entries(SOURCES).map(([value, label]) => ({ value, label: t(label) }))]} />
      <${Select} value=${quality} onChange=${setQuality} options=${[{ value: '', label: t('Tous les tracés') }, ...Object.entries(QUALITY).map(([value, label]) => ({ value, label: t(label) }))]} />
      <span class="small muted">${tn(list.length, '{n} carte', '{n} cartes')}</span>
      <${Button} small variant="ghost" onClick=${() => loadLibrary(true).catch(quiet)} title=${t('Recharger la bibliothèque')}>⟳</${Button}>
    </div>
    <div class="small muted">${t('Cartes brutes partagées par toutes les tables du serveur. Ajoute une carte pour en faire une copie modifiable dans cette table.')}</div>
    ${!list.length && html`<${Empty}>${data.maps.length ? t('Aucune carte ne correspond à ces filtres.') : t('La bibliothèque est vide.')}</${Empty}>`}
    <div class="maps-grid">
      ${list.map((e) => html`<${LibCard} key=${e.slug} entry=${e} k=${k} uses=${uses[e.slug] || 0} game=${game} onAdded=${onAdded} onPreview=${() => setPreview(e)} />`)}
    </div>
    ${preview && html`<${PreviewModal} entry=${preview} game=${game} onClose=${() => setPreview(null)} onAdded=${onAdded} />`}
  </div>`;
}

const STALE_KEY = 'La bibliothèque a changé depuis ta dernière synchronisation (v{lib}, ta carte : v{mine})';

function diffLines(d) {
  const line = (label, x) => (x.add || x.remove ? t('{what} : +{add} / −{remove}', { what: label, add: x.add, remove: x.remove }) : null);
  return [line(t('Murs'), d.walls), line(t('Portes'), d.doors), line(t('Lumières'), d.lights), line(t('Zones'), d.regions)].filter(Boolean);
}

/** Dialog of a library-linked table map. `beforeAction` (editor) flushes pending wall edits first. */
export function LibraryLinkModal({ map, onClose, beforeAction }) {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => send('maps/libraryDiff', { mapId: map.id }).then(setInfo, () => onClose());
  useEffect(() => {
    (beforeAction ? beforeAction() : Promise.resolve()).then(refresh, refresh);
  }, [map.id]);
  const run = async (fn) => {
    setBusy(true);
    try {
      if (beforeAction) await beforeAction();
      await fn();
      loadLibrary(true).catch(quiet);
      await refresh();
    } catch {}
    setBusy(false);
  };
  const update = () => run(async () => {
    if (!(await confirmAction(t('Remplacer les murs, portes, lumières et zones de « {name} » par ceux de la bibliothèque ? Les pions, notes, brouillard, zones MJ et l’état des portes restent.', { name: map.name })))) return;
    const r = await send('maps/libraryUpdate', { mapId: map.id });
    toast(t('Carte mise à jour (version {v})', { v: r.version }), 'success');
  });
  const publish = () => run(async () => {
    if (!(await confirmAction(t('Publier les murs, portes, lumières et zones de « {name} » dans la bibliothèque du serveur ? Toutes les tables en profiteront. Les pions, notes, brouillard et zones MJ ne sont jamais publiés, les portes repartent fermées.', { name: map.name })))) return;
    let r;
    try {
      r = await send('maps/publishToLibrary', { mapId: map.id }, { silent: true });
    } catch (err) {
      if (err.key !== STALE_KEY) {
        toast(err.message, 'error');
        throw err;
      }
      if (!(await confirmAction(t('Quelqu’un a publié une version plus récente. Publier quand même (l’ancienne reste dans l’historique) ?')))) return;
      r = await send('maps/publishToLibrary', { mapId: map.id, force: true });
    }
    toast(t('Publiée dans la bibliothèque (version {v})', { v: r.version }), 'success');
  });
  const unlink = () => run(async () => {
    if (!(await confirmAction(t('Détacher « {name} » de la bibliothèque ? Elle devient une carte ordinaire de la table (plus de mise à jour ni de publication).', { name: map.name })))) return;
    await send('maps/libraryUnlink', { mapId: map.id });
    toast(t('Carte détachée de la bibliothèque'));
    onClose();
  });
  const d = info?.diff;
  const lines = d ? diffLines(d) : [];
  return html`<${Modal} title=${t('Bibliothèque : {name}', { name: map.name })} width=${560} onClose=${onClose}>
    ${!info ? html`<${Empty}>${t('Chargement…')}</${Empty}>` : html`<div class="col gap-s">
      <div>${t('Copie de « {name} » (bibliothèque du serveur).', { name: getLang() === 'en' ? info.name : info.nameFr || info.name })}</div>
      <div class="small muted">${t('Version de cette carte : {mine} · version de la bibliothèque : {lib}', { mine: info.current, lib: info.latest })}</div>
      ${info.latest > info.current ? html`<${Badge} color="amber">${t('Nouvelle version disponible')}</${Badge}>` : null}
      <div class="section-title">${t('Différences avec la bibliothèque')}</div>
      ${d.same ? html`<div class="small green">${t('Identique à la bibliothèque.')}</div>` : html`<ul class="small">
        ${lines.map((l) => html`<li>${l}</li>`)}
        ${d.resized ? html`<li>${t('Taille : {w} × {h} cases', { w: d.width, h: d.height })}</li>` : null}
      </ul>
      <div class="small muted">${t('« + » = présent dans la bibliothèque seulement, « − » = présent dans ta carte seulement.')}</div>`}
      ${d.keptDoorStates ? html`<div class="small muted">${tn(d.keptDoorStates, 'Une mise à jour garde l’état de {n} porte.', 'Une mise à jour garde l’état de {n} portes.')}</div>` : null}
      <div class="row wrap gap-s" style=${{ marginTop: '8px' }}>
        <${Button} variant="primary" disabled=${busy || (d.same && info.latest <= info.current)} onClick=${update}>${t('Mettre à jour depuis la bibliothèque')}</${Button}>
        ${info.publishAllowed
          ? html`<${Button} variant="accent" disabled=${busy || d.same} onClick=${publish}>${t('Publier mes corrections dans la bibliothèque')}</${Button}>`
          : html`<span class="small muted">${t('Publication réservée à l’administrateur du serveur.')}</span>`}
        <${Button} variant="ghost" disabled=${busy} onClick=${unlink}>${t('Détacher')}</${Button}>
      </div>
    </div>`}
  </${Modal}>`;
}
