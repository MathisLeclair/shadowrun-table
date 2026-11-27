// GM panel (Réglages): send a Foundry world to the server as a .zip (the server may be a VPS that cannot read
// the GM's PC), optionally plus a zip of extra Data assets. The Foundry panel below then scans/imports it.
import { useEffect, useState, type ChangeEvent } from 'react';
import { Button, Panel, Empty, confirmAction } from '../../lib/ui.tsx';
import { api, uploadWithProgress } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t } from '../../lib/i18n.js';
import { fmtBytes, Progress, type UploadProgress } from './common.tsx';

/** GET /api/foundry/uploads */
interface UploadsInfo {
  worlds: { title: string; path: string }[];
  bytes: number;
  maxBytes: number;
  localPaths: boolean;
}
type UploadKind = 'world' | 'data';

export default function FoundryUpload({ onChanged }: { onChanged?: () => void }) {
  const [info, setInfo] = useState<UploadsInfo | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [sending, setSending] = useState<UploadKind | ''>('');

  const load = () =>
    api<UploadsInfo>('/api/foundry/uploads')
      .then(setInfo)
      .catch(() => setInfo({ worlds: [], bytes: 0, maxBytes: 0, localPaths: true }));
  useEffect(() => {
    load();
  }, []);

  const send = async (kind: UploadKind, file: File | undefined) => {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) return toast(t('Choisis un fichier .zip'), 'error');
    if (info?.maxBytes && file.size > info.maxBytes) return toast(t('Fichier trop volumineux ({size} max)', { size: fmtBytes(info.maxBytes) }), 'error');
    setSending(kind);
    setProgress(0);
    try {
      const r = await uploadWithProgress<{ world: { title: string }; files: number; size: string }>(`/api/foundry/upload?kind=${kind}`, file, {
        onProgress: (p) => setProgress(p >= 1 ? 'server' : p),
      });
      if (kind === 'world') toast(t('Monde « {title} » prêt sur le serveur : lance « Analyser »', { title: r.world.title }), 'success');
      else toast(t('Fichiers ajoutés : {files} ({size})', { files: r.files, size: r.size }), 'success');
      await load();
      // Let the state broadcast carrying the new world path arrive (30 ms debounce) before the panel reloads.
      setTimeout(() => onChanged?.(), 250);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setProgress(null);
      setSending('');
    }
  };
  const pick = (kind: UploadKind) => (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
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
      toast((err as Error).message, 'error');
    }
  };

  const busy = progress !== null;
  return (
    <Panel title={t('Foundry VTT — monde sur le serveur')} className="foundry-upload">
      <div className="col">
        <p className="muted small">
          {t(
            'Le serveur ne peut pas lire Foundry sur ton ordinateur : zippe le dossier de ton monde ({path}, avec ses sous-dossiers data, scenes…) et envoie-le ici, puis utilise « Analyser » dans le panneau Foundry ci-dessous. Si des images ou musiques sont hors du dossier du monde (Data/Music, Data/img…), envoie-les aussi dans un second .zip.',
            { path: 'Foundry/Data/worlds/<…>' }
          )}
        </p>
        {info?.worlds?.length ? (
          <div className="admin-worlds">
            {info.worlds.map((w) => (
              <div className="admin-world" key={w.path}>
                <strong>{w.title}</strong>
                <span className="mono">{w.path}</span>
              </div>
            ))}
          </div>
        ) : (
          <Empty>{t('Aucun monde téléversé pour cette table.')}</Empty>
        )}
        {progress !== null && <Progress value={progress}serverLabel={sending === 'world' ? t('Décompression et vérification du monde…') : t('Décompression des fichiers…')} />}
        <div className="row wrap">
          <label className={'btn btn-primary' + (busy ? ' disabled' : '')}>
            {t('Téléverser un monde Foundry (.zip)')}
            <input type="file" accept=".zip" className="hidden" disabled={busy} onChange={pick('world')} />
          </label>
          <label className={'btn' + (busy ? ' disabled' : '')}>
            {t('Ajouter des fichiers Data (.zip, optionnel)')}
            <input type="file" accept=".zip" className="hidden" disabled={busy} onChange={pick('data')} />
          </label>
          {info && info.bytes > 0 && (
            <Button variant="ghost" disabled={busy} onClick={removeAll}>
              {t('Effacer les fichiers téléversés ({size})', { size: fmtBytes(info.bytes) })}
            </Button>
          )}
        </div>
        <span className="field-hint">
          {info?.maxBytes ? t('Taille max par fichier : {size}.', { size: fmtBytes(info.maxBytes) }) + ' ' : ''}
          {info?.localPaths ? t('Sur ce PC, tu peux aussi indiquer directement le chemin du monde ci-dessous.') : ''}
        </span>
      </div>
    </Panel>
  );
}
