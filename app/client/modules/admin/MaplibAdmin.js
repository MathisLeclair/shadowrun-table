// « Bibliothèque de cartes » panel of the /admin page: the server-wide map library (see ARCHITECTURE.md « Map library »).
// List with usage per table, rename / tags, history + rollback, revert to the git / Foundry original, publish a table's
// corrections, delete, upload an image to create an entry, setting « publication réservée à l'administrateur ».
import { useEffect, useMemo, useState } from 'preact/hooks';
import { html, Button, Field, Toggle, Badge, Empty, Modal, Select, SearchBox, confirmAction } from '../../lib/ui.js';
import { uploadWithProgress } from '../../lib/net.js';
import { toast } from '../../lib/ui-store.js';
import { t, tn, tk, fmtDate, getLang } from '../../lib/i18n.js';
import { matchesQuery } from '/shared/maplib.js';
import { setLibKeySource, useLibKey, signedUrl } from '../map/maplib-client.js';
import { themeOptions, lightingOptions } from '../map/renderer.js';
import { fmtBytes, Progress } from './common.js';

const ORIGINS = { git: tk('git'), seed: tk('Foundry'), edited: tk('maplib::modifiée'), upload: tk('téléversée') };
const SOURCES = { fragmap: tk('Fragmaps (Patreon)'), 'fragmaps-free': tk('Fragmaps (gratuites)') };
const nameOf = (e) => (getLang() === 'en' ? e.name || e.nameFr : e.nameFr || e.name) || e.slug;
const slugOf = (s) =>
  String(s || '')
    .replace(/\.[^.]+$/, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
const byLabel = (b) => (!b ? '' : b.kind === 'gm' ? t('MJ de {table}', { table: b.table || b.tableId }) : b.kind === 'admin' ? (b.table ? t('admin (depuis {table})', { table: b.table }) : t('admin')) : b.kind === 'git' ? 'git' : b.kind === 'seed' ? 'Foundry' : b.kind);

function EditModal({ entry, adminApi, onClose, onSaved }) {
  const [f, setF] = useState({ name: entry.name, nameFr: entry.nameFr, tags: (entry.tags || []).join(', '), description: entry.description || '', theme: entry.theme, lighting: entry.lighting });
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF((o) => ({ ...o, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      await adminApi(`/api/admin/maplib/${entry.slug}`, { method: 'PATCH', body: { ...f, tags: f.tags.split(',').map((x) => x.trim()).filter(Boolean) } });
      toast(t('Carte {name} enregistrée', { name: f.nameFr || f.name }), 'success');
      onSaved();
      onClose();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return html`<${Modal} title=${t('Modifier « {name} »', { name: nameOf(entry) })} width=${560} onClose=${onClose}
    actions=${html`<${Button} variant="primary" disabled=${busy} onClick=${save}>${t('Enregistrer')}</${Button}>`}>
    <div class="col gap-s">
      <div class="grid-2">
        <${Field} label=${t('Nom français')}><input class="input" value=${f.nameFr} onInput=${(e) => set('nameFr')(e.target.value)} /></${Field}>
        <${Field} label=${t('Nom anglais')}><input class="input" value=${f.name} onInput=${(e) => set('name')(e.target.value)} /></${Field}>
        <${Field} label=${t('Ambiance')}><${Select} value=${f.theme} options=${themeOptions()} onChange=${set('theme')} /></${Field}>
        <${Field} label=${t('Éclairage')}><${Select} value=${f.lighting} options=${lightingOptions()} onChange=${set('lighting')} /></${Field}>
      </div>
      <${Field} label=${t('Mots-clés')} hint=${t('Séparés par des virgules (français et anglais)')}><input class="input" value=${f.tags} onInput=${(e) => set('tags')(e.target.value)} /></${Field}>
      <${Field} label=${t('Description')}><textarea class="input" rows="4" value=${f.description} onInput=${(e) => set('description')(e.target.value)}></textarea></${Field}>
      <span class="small muted">${t('Ces champs restent prioritaires sur les mises à jour venant de git.')}</span>
    </div>
  </${Modal}>`;
}

function HistoryModal({ entry, adminApi, onClose, onSaved }) {
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState('');
  const run = async (fn) => {
    setBusy(true);
    try {
      const r = await fn();
      toast(t('Version {v} créée', { v: r?.version }), 'success');
      onSaved();
      onClose();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const rollback = async (v) => {
    if (!(await confirmAction(t('Rétablir la version {v} de « {name} » ? Elle devient une nouvelle version (l’actuelle reste dans l’historique).', { v, name: nameOf(entry) })))) return;
    run(() => adminApi(`/api/admin/maplib/${entry.slug}/rollback`, { method: 'POST', body: { version: v } }));
  };
  const revert = async () => {
    if (!(await confirmAction(t('Revenir à la version d’origine de « {name} » (git ou Foundry) ? Les corrections publiées restent dans l’historique, et les mises à jour git s’appliqueront de nouveau.', { name: nameOf(entry) })))) return;
    run(() => adminApi(`/api/admin/maplib/${entry.slug}/revert`, { method: 'POST' }));
  };
  const candidates = (entry.usedBy || []).flatMap((u) => u.maps.map((m) => ({ value: `${u.tableId}|${m.id}`, label: `${u.tableName} — ${m.name} (v${m.version})` })));
  const publish = async (force = false) => {
    const [tableId, mapId] = pick.split('|');
    if (!tableId) return;
    if (!force && !(await confirmAction(t('Publier les murs de cette carte de table comme nouvelle version de « {name} » ?', { name: nameOf(entry) })))) return;
    setBusy(true);
    try {
      const r = await adminApi(`/api/admin/maplib/${entry.slug}/publish`, { method: 'POST', body: { tableId, mapId, force } });
      toast(t('Version {v} créée', { v: r.version }), 'success');
      onSaved();
      onClose();
    } catch (err) {
      if (err.code === 'stale' && !force && (await confirmAction(t('Cette carte de table part d’une version plus ancienne. Publier quand même ?')))) {
        setBusy(false);
        return publish(true);
      }
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const cur = { version: entry.version, at: entry.versionInfo?.at || entry.updatedAt, by: entry.versionInfo?.by, origin: entry.origin, counts: entry.counts, current: true };
  return html`<${Modal} title=${t('Historique de « {name} »', { name: nameOf(entry) })} width=${640} onClose=${onClose}>
    <div class="col gap-s">
      <table class="sr">
        <thead><tr><th>${t('Version')}</th><th>${t('Date')}</th><th>${t('Par')}</th><th>${t('Contenu')}</th><th></th></tr></thead>
        <tbody>
          ${[cur, ...(entry.history || [])].map((h) => html`<tr>
            <td>v${h.version}${h.current ? html` <${Badge} color="green">${t('actuelle')}</${Badge}>` : null}</td>
            <td class="small">${h.at ? fmtDate(h.at) : ''}</td>
            <td class="small">${byLabel(h.by)}</td>
            <td class="small muted">${h.counts ? t('{walls} murs, {doors} portes, {lights} lumières', h.counts) : ''}</td>
            <td>${h.current ? null : html`<${Button} small disabled=${busy} onClick=${() => rollback(h.version)}>${t('Rétablir')}</${Button}>`}</td>
          </tr>`)}
        </tbody>
      </table>
      ${entry.canRevert ? html`<div><${Button} small disabled=${busy} onClick=${revert}>${t('Revenir à la version d’origine')}</${Button}>
        ${entry.gitNewer ? html` <span class="small amber">${t('Une version plus récente existe dans git.')}</span>` : null}</div>` : null}
      <div class="section-title">${t('Publier depuis une table')}</div>
      ${candidates.length
        ? html`<div class="row wrap gap-s">
            <${Select} value=${pick} onChange=${setPick} options=${[{ value: '', label: t('Choisir une carte de table…') }, ...candidates]} />
            <${Button} small variant="accent" disabled=${busy || !pick} onClick=${() => publish(false)}>${t('Publier')}</${Button}>
          </div>`
        : html`<span class="small muted">${t('Aucune table n’utilise cette carte.')}</span>`}
    </div>
  </${Modal}>`;
}

function UploadForm({ token, maxBytes, onDone }) {
  const [file, setFile] = useState(null);
  const [f, setF] = useState({ slug: '', nameFr: '', name: '', gridPx: '70', source: 'fragmap', replace: false });
  const [progress, setProgress] = useState(null);
  const set = (k) => (v) => setF((o) => ({ ...o, [k]: v }));
  const choose = (e) => {
    const x = e.target.files?.[0] || null;
    setFile(x);
    if (x) setF((o) => ({ ...o, slug: o.slug || slugOf(x.name), name: o.name || x.name.replace(/\.[^.]+$/, '') }));
  };
  const send = async () => {
    if (!file) return;
    if (maxBytes && file.size > maxBytes) return toast(t('Fichier trop volumineux ({size} max)', { size: fmtBytes(maxBytes) }), 'error');
    try {
      const q = new URLSearchParams({ slug: f.slug, name: f.name, nameFr: f.nameFr, gridPx: f.gridPx, source: f.source });
      if (f.replace) q.set('replace', '1');
      const r = await uploadWithProgress(`/api/admin/maplib/upload?${q}`, file, { token, headers: { 'X-Filename': encodeURIComponent(file.name).slice(0, 200) }, onProgress: (p) => setProgress(p >= 1 ? 'server' : p) });
      toast(r?.thumb ? t('Carte {slug} ajoutée', { slug: f.slug }) : t('Carte {slug} ajoutée (sans miniature : lance tools/maplib-build.js)', { slug: f.slug }), 'success');
      setFile(null);
      setF((o) => ({ ...o, slug: '', name: '', nameFr: '', replace: false }));
      onDone();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setProgress(null);
    }
  };
  return html`<div class="col gap-s">
    <input type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" onChange=${choose} />
    <div class="grid-2">
      <${Field} label=${t('Identifiant')} hint=${t('minuscules, chiffres, tirets')}><input class="input" value=${f.slug} onInput=${(e) => set('slug')(e.target.value)} /></${Field}>
      <${Field} label=${t('Pixels par case')}><input class="input" type="number" min="4" step="any" value=${f.gridPx} onInput=${(e) => set('gridPx')(e.target.value)} /></${Field}>
      <${Field} label=${t('Nom français')}><input class="input" value=${f.nameFr} onInput=${(e) => set('nameFr')(e.target.value)} /></${Field}>
      <${Field} label=${t('Nom anglais')}><input class="input" value=${f.name} onInput=${(e) => set('name')(e.target.value)} /></${Field}>
      <${Field} label=${t('Source')}><${Select} value=${f.source} onChange=${set('source')} options=${Object.entries(SOURCES).map(([value, label]) => ({ value, label: t(label) }))} /></${Field}>
    </div>
    <${Toggle} value=${f.replace} onChange=${set('replace')} label=${t('Remplacer l’image d’une carte existante')} />
    ${progress != null ? html`<${Progress} value=${progress} serverLabel=${t('Miniature en cours…')} />` : html`<div><${Button} variant="primary" disabled=${!file || !f.slug} onClick=${send}>${t('Téléverser')}</${Button}></div>`}
    <span class="small muted">${t('La carte arrive sans murs : ajoute-la à une table, trace les murs dans l’éditeur, puis « Publier mes corrections dans la bibliothèque ».')}</span>
  </div>`;
}

export default function MaplibAdmin({ adminApi, token, run }) {
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState(null);
  const [hist, setHist] = useState(null);
  const [showUpload, setShowUpload] = useState(false);
  useMemo(() => setLibKeySource(() => adminApi('/api/admin/maplib/key')), []);
  const k = useLibKey();
  const reload = () => run(async () => setData(await adminApi('/api/admin/maplib')));
  useEffect(() => {
    reload();
  }, []);
  if (!data) return html`<${Empty}>${t('Chargement…')}</${Empty}>`;
  const list = data.maps.filter((e) => matchesQuery(e, q)).sort((a, b) => nameOf(a).localeCompare(nameOf(b), getLang()));
  const del = async (e) => {
    const n = (e.usedBy || []).reduce((s, u) => s + u.maps.length, 0);
    const msg = t('Retirer « {name} » de la bibliothèque ?', { name: nameOf(e) }) + (n ? '\n' + tn(n, '{n} carte de table en est une copie : elle garde son image et ses murs.', '{n} cartes de table en sont des copies : elles gardent leur image et leurs murs.') : '');
    if (!(await confirmAction(msg))) return;
    run(async () => {
      await adminApi(`/api/admin/maplib/${e.slug}`, { method: 'DELETE', body: { confirm: e.slug } });
      toast(t('Carte retirée de la bibliothèque'));
      setData(await adminApi('/api/admin/maplib'));
    });
  };
  const missing = data.maps.filter((e) => !e.hasImage).length;
  return html`<div class="col gap-s">
    <div class="row wrap gap-s">
      <${Toggle} value=${!!data.settings?.publishAdminOnly} label=${t('Publication réservée à l’administrateur')}
        title=${t('Sinon, tout MJ peut publier ses corrections de murs (l’historique garde les 5 versions précédentes)')}
        onChange=${(v) => run(async () => { await adminApi('/api/admin/maplib/settings', { method: 'PATCH', body: { publishAdminOnly: v } }); setData(await adminApi('/api/admin/maplib')); })} />
      <span class="grow"></span>
      <${SearchBox} value=${q} onChange=${setQ} placeholder=${t('Rechercher une carte…')} />
      <${Button} small onClick=${() => setShowUpload(!showUpload)}>${showUpload ? t('Fermer') : t('+ Téléverser une image')}</${Button}>
    </div>
    <div class="small muted">
      ${tn(data.maps.length, '{n} carte dans la bibliothèque', '{n} cartes dans la bibliothèque')}
      ${missing ? html` · <span class="amber">${tn(missing, '{n} image manquante sur le serveur', '{n} images manquantes sur le serveur')}</span>` : null}
    </div>
    ${showUpload && html`<div class="card"><${UploadForm} token=${token} maxBytes=${data.maxBytes} onDone=${reload} /></div>`}
    ${!list.length ? html`<${Empty}>${t('Aucune carte.')}</${Empty}>` : html`<div class="admin-maplib-list">
      <table class="sr">
        <thead><tr><th></th><th>${t('Carte')}</th><th>${t('Version')}</th><th>${t('Utilisée par')}</th><th></th></tr></thead>
        <tbody>
          ${list.map((e) => {
            const src = signedUrl(e.thumb, k);
            return html`<tr key=${e.slug}>
              <td class="admin-maplib-thumb">${src && (e.hasThumb || !e.hasImage) ? html`<img src=${src} alt="" loading="lazy" />` : null}</td>
              <td>
                <strong>${nameOf(e)}</strong> <span class="muted small mono">${e.slug}</span><br />
                <span class="small muted">${t(SOURCES[e.source] || e.source)} · ${e.width} × ${e.height} · ${e.quality === 'good' ? t('murs soignés') : t('murs approximatifs')}</span>
                ${!e.hasImage ? html` <${Badge} color="red">${t('image manquante')}</${Badge}>` : null}
              </td>
              <td class="small">v${e.version} <${Badge} color=${e.origin === 'edited' ? 'amber' : 'dim'}>${t(ORIGINS[e.origin] || e.origin)}</${Badge}>
                ${e.gitNewer ? html`<br /><span class="amber">${t('git plus récent')}</span>` : null}</td>
              <td class="small">${(e.usedBy || []).length ? e.usedBy.map((u) => html`<div>${u.tableName} <span class="muted">(${u.maps.map((m) => `v${m.version}`).join(', ')})</span></div>`) : html`<span class="muted">—</span>`}</td>
              <td class="row wrap gap-s">
                <${Button} small onClick=${() => setEdit(e)}>${t('Modifier')}</${Button}>
                <${Button} small onClick=${() => setHist(e)}>${t('Historique')}</${Button}>
                <${Button} small variant="danger" onClick=${() => del(e)}>${t('Retirer')}</${Button}>
              </td>
            </tr>`;
          })}
        </tbody>
      </table>
    </div>`}
    ${edit && html`<${EditModal} entry=${edit} adminApi=${adminApi} onClose=${() => setEdit(null)} onSaved=${reload} />`}
    ${hist && html`<${HistoryModal} entry=${hist} adminApi=${adminApi} onClose=${() => setHist(null)} onSaved=${reload} />`}
  </div>`;
}
