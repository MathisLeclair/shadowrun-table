// GM panel (Réglages): send a Foundry world to the server as a .zip (the server may be a VPS that cannot read
// the GM's PC), optionally plus a zip of extra Data assets. The Foundry panel below then scans/imports it.
import { useEffect, useState, type ChangeEvent } from 'react';
import { Button, Panel, Empty, confirmAction } from '../../lib/ui.tsx';
import { api, uploadWithProgress } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t } from '../../lib/i18n.ts';
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
    if (!/\.zip$/i.test(file.name)) return toast(t('Choose a .zip file'), 'error');
    if (info?.maxBytes && file.size > info.maxBytes) return toast(t('File too large ({size} max)', { size: fmtBytes(info.maxBytes) }), 'error');
    setSending(kind);
    setProgress(0);
    try {
      const r = await uploadWithProgress<{ world: { title: string }; files: number; size: string }>(`/api/foundry/upload?kind=${kind}`, file, {
        onProgress: (p) => setProgress(p >= 1 ? 'server' : p),
      });
      if (kind === 'world') toast(t('World “{title}” ready on the server: run “Scan”', { title: r.world.title }), 'success');
      else toast(t('Files added: {files} ({size})', { files: r.files, size: r.size }), 'success');
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
    if (!(await confirmAction(t('Delete the Foundry worlds and files uploaded for this table from the server? Maps, portraits and sounds already imported stay.')))) return;
    try {
      await api('/api/foundry/uploads', { method: 'DELETE' });
      toast(t('Uploaded Foundry files deleted'), 'success');
      await load();
      onChanged?.();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const busy = progress !== null;
  return (
    <Panel title={t('Foundry VTT — world on the server')} className="foundry-upload">
      <div className="col">
        <p className="muted small">
          {t(
            'The server cannot read Foundry on your computer: zip your world\'s folder ({path}, with its data, scenes… subfolders) and upload it here, then use “Scan” in the Foundry panel below. If images or music live outside the world folder (Data/Music, Data/img…), upload them too in a second .zip.',
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
          <Empty>{t('No world uploaded for this table.')}</Empty>
        )}
        {progress !== null && <Progress value={progress}serverLabel={sending === 'world' ? t('Unpacking and checking the world…') : t('Unpacking the files…')} />}
        <div className="row wrap">
          <label className={'btn btn-primary' + (busy ? ' disabled' : '')}>
            {t('Upload a Foundry world (.zip)')}
            <input type="file" accept=".zip" className="hidden" disabled={busy} onChange={pick('world')} />
          </label>
          <label className={'btn' + (busy ? ' disabled' : '')}>
            {t('Add Data files (.zip, optional)')}
            <input type="file" accept=".zip" className="hidden" disabled={busy} onChange={pick('data')} />
          </label>
          {info && info.bytes > 0 && (
            <Button variant="ghost" disabled={busy} onClick={removeAll}>
              {t('Delete the uploaded files ({size})', { size: fmtBytes(info.bytes) })}
            </Button>
          )}
        </div>
        <span className="field-hint">
          {info?.maxBytes ? t('Max size per file: {size}.', { size: fmtBytes(info.maxBytes) }) + ' ' : ''}
          {info?.localPaths ? t('On this PC, you can also enter the world\'s path directly below.') : ''}
        </span>
      </div>
    </Panel>
  );
}
