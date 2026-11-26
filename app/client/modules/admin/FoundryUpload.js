// GM panel (Réglages): send a Foundry world to the server as a .zip (the server may be a VPS that cannot read
// the GM's PC), optionally plus a zip of extra Data assets. The Foundry panel below then scans/imports it.
import { useEffect, useState } from 'preact/hooks';
import { html, Button, Panel, Empty, confirmAction } from '../../lib/ui.js';
import { api, uploadWithProgress } from '../../lib/net.js';
import { toast } from '../../lib/ui-store.js';
import { t } from '../../lib/i18n.js';
import { fmtBytes, Progress } from './common.js';

export default function FoundryUpload({ onChanged }) {
  const [info, setInfo] = useState(null);
  const [progress, setProgress] = useState(null); // null | 0..1 | 'server'
  const [sending, setSending] = useState('');

  const load = () =>
    api('/api/foundry/uploads')
      .then(setInfo)
      .catch(() => setInfo({ worlds: [], bytes: 0, maxBytes: 0, localPaths: true }));
  useEffect(() => {
    load();
  }, []);

  const send = async (kind, file) => {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) return toast(t('Choisis un fichier .zip'), 'error');
    if (info?.maxBytes && file.size > info.maxBytes) return toast(t('Fichier trop volumineux ({size} max)', { size: fmtBytes(info.maxBytes) }), 'error');
    setSending(kind);
    setProgress(0);
    try {
      const r = await uploadWithProgress(`/api/foundry/upload?kind=${kind}`, file, { onProgress: (p) => setProgress(p >= 1 ? 'server' : p) });
      if (kind === 'world') toast(t('Monde « {title} » prêt sur le serveur : lance « Analyser »', { title: r.world.title }), 'success');
      else toast(t('Fichiers ajoutés : {files} ({size})', { files: r.files, size: r.size }), 'success');
      await load();
      // Let the state broadcast carrying the new world path arrive (30 ms debounce) before the panel reloads.
      setTimeout(() => onChanged?.(), 250);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setProgress(null);
      setSending('');
    }
  };
  const pick = (kind) => (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    send(kind, f);
  };
  const removeAll = async () => {
    if (!(await confirmAction(t('Effacer du serveur les mondes et fichiers Foundry téléversés pour cette table ? Les cartes, portraits et sons déjà importés restent.')))) return;
    try {
      await api('/api/foundry/uploads', { method: 'DELETE' });
      toast(t('Fichiers Foundry téléversés effacés'), 'success');
      await load();
      onChanged?.();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const busy = progress !== null;
  return html`<${Panel} title=${t('Foundry VTT — monde sur le serveur')} class="foundry-upload">
    <div class="col">
      <p class="muted small">
        ${t('Le serveur ne peut pas lire Foundry sur ton ordinateur : zippe le dossier de ton monde ({path}, avec ses sous-dossiers data, scenes…) et envoie-le ici, puis utilise « Analyser » dans le panneau Foundry ci-dessous. Si des images ou musiques sont hors du dossier du monde (Data/Music, Data/img…), envoie-les aussi dans un second .zip.', { path: 'Foundry/Data/worlds/<…>' })}
      </p>
      ${info?.worlds?.length
        ? html`<div class="admin-worlds">${info.worlds.map(
            (w) => html`<div class="admin-world"><strong>${w.title}</strong><span class="mono">${w.path}</span></div>`
          )}</div>`
        : html`<${Empty}>${t('Aucun monde téléversé pour cette table.')}</${Empty}>`}
      ${busy && html`<${Progress} value=${progress} serverLabel=${sending === 'world' ? t('Décompression et vérification du monde…') : t('Décompression des fichiers…')} />`}
      <div class="row wrap">
        <label class=${'btn btn-primary' + (busy ? ' disabled' : '')}>${t('Téléverser un monde Foundry (.zip)')}
          <input type="file" accept=".zip" class="hidden" disabled=${busy} onChange=${pick('world')} /></label>
        <label class=${'btn' + (busy ? ' disabled' : '')}>${t('Ajouter des fichiers Data (.zip, optionnel)')}
          <input type="file" accept=".zip" class="hidden" disabled=${busy} onChange=${pick('data')} /></label>
        ${info?.bytes > 0 && html`<${Button} variant="ghost" disabled=${busy} onClick=${removeAll}>${t('Effacer les fichiers téléversés ({size})', { size: fmtBytes(info.bytes) })}</${Button}>`}
      </div>
      <span class="field-hint">
        ${info?.maxBytes ? t('Taille max par fichier : {size}.', { size: fmtBytes(info.maxBytes) }) + ' ' : ''}${info?.localPaths ? t('Sur ce PC, tu peux aussi indiquer directement le chemin du monde ci-dessous.') : ''}
      </span>
    </div>
  </${Panel}>`;
}
