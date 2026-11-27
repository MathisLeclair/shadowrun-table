// « Bibliothèque de cartes » panel of the /admin page: the server-wide map library (see ARCHITECTURE.md « Map library »).
// List with usage per table, rename / tags, history + rollback, revert to the git / Foundry original, publish a table's
// corrections, delete, upload an image to create an entry, setting « publication réservée à l'administrateur ».
import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { Button, Field, Toggle, Badge, Empty, Modal, Select, SearchBox, confirmAction } from '../../lib/ui.tsx';
import { uploadWithProgress, type ServerError } from '../../lib/net.ts';
import { toast } from '../../lib/ui-store.ts';
import { t, tn, tk, fmtDate, getLang } from '../../lib/i18n.ts';
import { matchesQuery } from '/shared/maplib.ts';
import { setLibKeySource, useLibKey, signedUrl } from '../map/maplib-client.ts';
import { themeOptions, lightingOptions } from '../map/renderer.ts';
import { fmtBytes, Progress, type UploadProgress } from './common.tsx';
import type { AdminApi, AdminPanelProps } from './types.ts';

/** Who made a library version. */
interface VersionBy {
  kind: 'gm' | 'admin' | 'git' | 'seed' | string;
  table?: string;
  tableId?: string;
}
interface VersionCounts {
  walls: number;
  doors: number;
  lights: number;
}
interface HistoryRow {
  version: number;
  at?: number;
  by?: VersionBy;
  origin?: string;
  counts?: VersionCounts;
  current?: boolean;
}
/** A library entry as GET /api/admin/maplib lists it (server/lib/maplib-admin.js). */
interface LibEntry {
  slug: string;
  name: string;
  nameFr: string;
  tags?: string[];
  description?: string;
  theme: string;
  lighting: string;
  source: string;
  width: number;
  height: number;
  quality?: string;
  version: number;
  versionInfo?: { at?: number; by?: VersionBy };
  updatedAt?: number;
  origin: string;
  counts?: VersionCounts;
  history?: HistoryRow[];
  canRevert?: boolean;
  gitNewer?: boolean;
  hasImage?: boolean;
  hasThumb?: boolean;
  thumb: string;
  usedBy?: { tableId: string; tableName: string; maps: { id: string; name: string; version: number }[] }[];
}
interface MaplibReply {
  maps: LibEntry[];
  settings?: { publishAdminOnly?: boolean };
  maxBytes: number;
}

const ORIGINS: Record<string, string> = { git: tk('git'), seed: tk('Foundry'), edited: tk('maplib::edited'), upload: tk('uploaded') };
const SOURCES: Record<string, string> = { fragmap: tk('Fragmaps (Patreon)'), 'fragmaps-free': tk('Fragmaps (free)') };
const nameOf = (e: LibEntry): string => (getLang() === 'en' ? e.name || e.nameFr : e.nameFr || e.name) || e.slug;
const slugOf = (s: string) =>
  String(s || '')
    .replace(/\.[^.]+$/, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
const byLabel = (b: VersionBy | undefined) =>
  !b
    ? ''
    : b.kind === 'gm'
      ? t('GM of {table}', { table: b.table || b.tableId })
      : b.kind === 'admin'
        ? b.table
          ? t('admin (from {table})', { table: b.table })
          : t('admin')
        : b.kind === 'git'
          ? 'git'
          : b.kind === 'seed'
            ? 'Foundry'
            : b.kind;

interface EditForm {
  name: string;
  nameFr: string;
  tags: string;
  description: string;
  theme: string;
  lighting: string;
}

function EditModal({ entry, adminApi, onClose, onSaved }: { entry: LibEntry; adminApi: AdminApi; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<EditForm>({ name: entry.name, nameFr: entry.nameFr, tags: (entry.tags || []).join(', '), description: entry.description || '', theme: entry.theme, lighting: entry.lighting });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof EditForm) => (v: string) => setF((o) => ({ ...o, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      await adminApi(`/api/admin/maplib/${entry.slug}`, {
        method: 'PATCH',
        body: {
          ...f,
          tags: f.tags
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
        },
      });
      toast(t('Map {name} saved', { name: f.nameFr || f.name }), 'success');
      onSaved();
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t('Edit “{name}”', { name: nameOf(entry) })}
      width={560}
      onClose={onClose}
      actions={
        <Button variant="primary" disabled={busy} onClick={save}>
          {t('Save')}
        </Button>
      }
    >
      <div className="col gap-s">
        <div className="grid-2">
          <Field label={t('French name')}>
            <input className="input" value={f.nameFr} onChange={(e) => set('nameFr')(e.target.value)} />
          </Field>
          <Field label={t('English name')}>
            <input className="input" value={f.name} onChange={(e) => set('name')(e.target.value)} />
          </Field>
          <Field label={t('Ambience')}>
            <Select value={f.theme} options={themeOptions()} onChange={set('theme')} />
          </Field>
          <Field label={t('Lighting')}>
            <Select value={f.lighting} options={lightingOptions()} onChange={set('lighting')} />
          </Field>
        </div>
        <Field label={t('Keywords')} hint={t('Comma-separated (French and English)')}>
          <input className="input" value={f.tags} onChange={(e) => set('tags')(e.target.value)} />
        </Field>
        <Field label={t('Description')}>
          <textarea className="input" rows={4} value={f.description} onChange={(e) => set('description')(e.target.value)}></textarea>
        </Field>
        <span className="small muted">{t('These fields take precedence over updates coming from git.')}</span>
      </div>
    </Modal>
  );
}

function HistoryModal({ entry, adminApi, onClose, onSaved }: { entry: LibEntry; adminApi: AdminApi; onClose: () => void; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState('');
  const run = async (fn: () => Promise<{ version?: number } | undefined>) => {
    setBusy(true);
    try {
      const r = await fn();
      toast(t('Version {v} created', { v: r?.version }), 'success');
      onSaved();
      onClose();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const rollback = async (v: number) => {
    if (!(await confirmAction(t('Restore version {v} of “{name}”? It becomes a new version (the current one stays in the history).', { v, name: nameOf(entry) })))) return;
    run(() => adminApi(`/api/admin/maplib/${entry.slug}/rollback`, { method: 'POST', body: { version: v } }));
  };
  const revert = async () => {
    if (
      !(await confirmAction(
        t('Go back to the original version of “{name}” (git or Foundry)? Published fixes stay in the history, and git updates will apply again.', { name: nameOf(entry) })
      ))
    )
      return;
    run(() => adminApi(`/api/admin/maplib/${entry.slug}/revert`, { method: 'POST' }));
  };
  const candidates = (entry.usedBy || []).flatMap((u) => u.maps.map((m) => ({ value: `${u.tableId}|${m.id}`, label: `${u.tableName} — ${m.name} (v${m.version})` })));
  const publish = async (force = false): Promise<void> => {
    const [tableId, mapId] = pick.split('|');
    if (!tableId) return;
    if (!force && !(await confirmAction(t('Publish the walls of this table map as a new version of “{name}”?', { name: nameOf(entry) })))) return;
    setBusy(true);
    try {
      const r = await adminApi<{ version: number }>(`/api/admin/maplib/${entry.slug}/publish`, { method: 'POST', body: { tableId, mapId, force } });
      toast(t('Version {v} created', { v: r.version }), 'success');
      onSaved();
      onClose();
    } catch (err) {
      if ((err as ServerError).code === 'stale' && !force && (await confirmAction(t('This table map is based on an older version. Publish anyway?')))) {
        setBusy(false);
        return publish(true);
      }
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const cur: HistoryRow = { version: entry.version, at: entry.versionInfo?.at || entry.updatedAt, by: entry.versionInfo?.by, origin: entry.origin, counts: entry.counts, current: true };
  return (
    <Modal title={t('History of “{name}”', { name: nameOf(entry) })} width={640} onClose={onClose}>
      <div className="col gap-s">
        <table className="sr">
          <thead>
            <tr>
              <th>{t('Version')}</th>
              <th>{t('Date')}</th>
              <th>{t('By')}</th>
              <th>{t('Content')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {[cur, ...(entry.history || [])].map((h) => (
              <tr key={`${h.version}${h.current ? '-current' : ''}`}>
                <td>
                  v{h.version}
                  {h.current ? (
                    <>
                      {' '}
                      <Badge color="green">{t('fem::current')}</Badge>
                    </>
                  ) : null}
                </td>
                <td className="small">{h.at ? fmtDate(h.at) : ''}</td>
                <td className="small">{byLabel(h.by)}</td>
                <td className="small muted">{h.counts ? t('{walls} walls, {doors} doors, {lights} lights', h.counts) : ''}</td>
                <td>
                  {h.current ? null : (
                    <Button small disabled={busy} onClick={() => rollback(h.version)}>
                      {t('Restore')}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {entry.canRevert ? (
          <div>
            <Button small disabled={busy} onClick={revert}>
              {t('Back to the original version')}
            </Button>
            {entry.gitNewer ? (
              <>
                {' '}
                <span className="small amber">{t('A newer version exists in git.')}</span>
              </>
            ) : null}
          </div>
        ) : null}
        <div className="section-title">{t('Publish from a table')}</div>
        {candidates.length ? (
          <div className="row wrap gap-s">
            <Select value={pick} onChange={setPick} options={[{ value: '', label: t('Pick a table map…') }, ...candidates]} />
            <Button small variant="accent" disabled={busy || !pick} onClick={() => publish(false)}>
              {t('Publish')}
            </Button>
          </div>
        ) : (
          <span className="small muted">{t('No table uses this map.')}</span>
        )}
      </div>
    </Modal>
  );
}

interface UploadFormState {
  slug: string;
  nameFr: string;
  name: string;
  gridPx: string;
  source: string;
  replace: boolean;
}

function UploadForm({ token, maxBytes, onDone }: { token: string; maxBytes: number; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [f, setF] = useState<UploadFormState>({ slug: '', nameFr: '', name: '', gridPx: '70', source: 'fragmap', replace: false });
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const set =
    <K extends keyof UploadFormState>(k: K) =>
    (v: UploadFormState[K]) =>
      setF((o) => ({ ...o, [k]: v }));
  const choose = (e: ChangeEvent<HTMLInputElement>) => {
    const x = e.target.files?.[0] || null;
    setFile(x);
    if (x) setF((o) => ({ ...o, slug: o.slug || slugOf(x.name), name: o.name || x.name.replace(/\.[^.]+$/, '') }));
  };
  const send = async () => {
    if (!file) return;
    if (maxBytes && file.size > maxBytes) return toast(t('File too large ({size} max)', { size: fmtBytes(maxBytes) }), 'error');
    try {
      const q = new URLSearchParams({ slug: f.slug, name: f.name, nameFr: f.nameFr, gridPx: f.gridPx, source: f.source });
      if (f.replace) q.set('replace', '1');
      const r = await uploadWithProgress<{ thumb?: string }>(`/api/admin/maplib/upload?${q}`, file, {
        token,
        headers: { 'X-Filename': encodeURIComponent(file.name).slice(0, 200) },
        onProgress: (p) => setProgress(p >= 1 ? 'server' : p),
      });
      toast(r?.thumb ? t('Map {slug} added', { slug: f.slug }) : t('Map {slug} added (no thumbnail: run tools/maplib-build.ts)', { slug: f.slug }), 'success');
      setFile(null);
      setF((o) => ({ ...o, slug: '', name: '', nameFr: '', replace: false }));
      onDone();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setProgress(null);
    }
  };
  return (
    <div className="col gap-s">
      <input type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" onChange={choose} />
      <div className="grid-2">
        <Field label={t('Id')} hint={t('lowercase, digits, dashes')}>
          <input className="input" value={f.slug} onChange={(e) => set('slug')(e.target.value)} />
        </Field>
        <Field label={t('Pixels per cell')}>
          <input className="input" type="number" min="4" step="any" value={f.gridPx} onChange={(e) => set('gridPx')(e.target.value)} />
        </Field>
        <Field label={t('French name')}>
          <input className="input" value={f.nameFr} onChange={(e) => set('nameFr')(e.target.value)} />
        </Field>
        <Field label={t('English name')}>
          <input className="input" value={f.name} onChange={(e) => set('name')(e.target.value)} />
        </Field>
        <Field label={t('Source')}>
          <Select value={f.source} onChange={set('source')} options={Object.entries(SOURCES).map(([value, label]) => ({ value, label: t(label) }))} />
        </Field>
      </div>
      <Toggle value={f.replace} onChange={set('replace')} label={t('Replace the image of an existing map')} />
      {progress != null ? (
        <Progress value={progress} serverLabel={t('Making the thumbnail…')} />
      ) : (
        <div>
          <Button variant="primary" disabled={!file || !f.slug} onClick={send}>
            {t('Upload')}
          </Button>
        </div>
      )}
      <span className="small muted">{t('The map comes without walls: add it to a table, trace the walls in the editor, then “Publish my fixes to the library”.')}</span>
    </div>
  );
}

export default function MaplibAdmin({ adminApi, token, run }: AdminPanelProps) {
  const [data, setData] = useState<MaplibReply | null>(null);
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<LibEntry | null>(null);
  const [hist, setHist] = useState<LibEntry | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  useMemo(() => setLibKeySource(() => adminApi('/api/admin/maplib/key')), []);
  const k = useLibKey();
  const reload = () => run(async () => setData(await adminApi<MaplibReply>('/api/admin/maplib')));
  useEffect(() => {
    reload();
  }, []);
  if (!data) return <Empty>{t('Loading…')}</Empty>;
  const list = data.maps.filter((e) => matchesQuery(e, q)).sort((a, b) => nameOf(a).localeCompare(nameOf(b), getLang()));
  const del = async (e: LibEntry) => {
    const n = (e.usedBy || []).reduce((s, u) => s + u.maps.length, 0);
    const msg =
      t('Remove “{name}” from the library?', { name: nameOf(e) }) +
      (n ? '\n' + tn(n, '{n} table map is a copy of it: it keeps its image and walls.', '{n} table maps are copies of it: they keep their image and walls.') : '');
    if (!(await confirmAction(msg))) return;
    run(async () => {
      await adminApi(`/api/admin/maplib/${e.slug}`, { method: 'DELETE', body: { confirm: e.slug } });
      toast(t('Map removed from the library'));
      setData(await adminApi<MaplibReply>('/api/admin/maplib'));
    });
  };
  const missing = data.maps.filter((e) => !e.hasImage).length;
  return (
    <div className="col gap-s">
      <div className="row wrap gap-s">
        <Toggle
          value={!!data.settings?.publishAdminOnly}
          label={t('Publishing reserved to the admin')}
          title={t('Otherwise any GM may publish wall fixes (the history keeps the 5 previous versions)')}
          onChange={(v) =>
            run(async () => {
              await adminApi('/api/admin/maplib/settings', { method: 'PATCH', body: { publishAdminOnly: v } });
              setData(await adminApi<MaplibReply>('/api/admin/maplib'));
            })
          }
        />
        <span className="grow"></span>
        <SearchBox value={q} onChange={setQ} placeholder={t('Search for a map…')} />
        <Button small onClick={() => setShowUpload(!showUpload)}>
          {showUpload ? t('Close') : t('+ Upload an image')}
        </Button>
      </div>
      <div className="small muted">
        {tn(data.maps.length, '{n} map in the library', '{n} maps in the library')}
        {missing ? (
          <>
            {' · '}
            <span className="amber">{tn(missing, '{n} image missing on the server', '{n} images missing on the server')}</span>
          </>
        ) : null}
      </div>
      {showUpload && (
        <div className="card">
          <UploadForm token={token} maxBytes={data.maxBytes} onDone={reload} />
        </div>
      )}
      {!list.length ? (
        <Empty>{t('No maps.')}</Empty>
      ) : (
        <div className="admin-maplib-list">
          <table className="sr">
            <thead>
              <tr>
                <th></th>
                <th>{t('Map')}</th>
                <th>{t('Version')}</th>
                <th>{t('Used by')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map((e) => {
                const src = signedUrl(e.thumb, k);
                return (
                  <tr key={e.slug}>
                    <td className="admin-maplib-thumb">{src && (e.hasThumb || !e.hasImage) ? <img src={src} alt="" loading="lazy" /> : null}</td>
                    <td>
                      <strong>{nameOf(e)}</strong> <span className="muted small mono">{e.slug}</span>
                      <br />
                      <span className="small muted">
                        {t(SOURCES[e.source] || e.source)} · {e.width} × {e.height} · {e.quality === 'good' ? t('clean walls') : t('rough walls')}
                      </span>
                      {!e.hasImage ? (
                        <>
                          {' '}
                          <Badge color="red">{t('image missing')}</Badge>
                        </>
                      ) : null}
                    </td>
                    <td className="small">
                      v{e.version} <Badge color={e.origin === 'edited' ? 'amber' : 'dim'}>{t(ORIGINS[e.origin] || e.origin)}</Badge>
                      {e.gitNewer ? (
                        <>
                          <br />
                          <span className="amber">{t('newer in git')}</span>
                        </>
                      ) : null}
                    </td>
                    <td className="small">
                      {(e.usedBy || []).length ? (
                        (e.usedBy || []).map((u) => (
                          <div key={u.tableId}>
                            {u.tableName} <span className="muted">({u.maps.map((m) => `v${m.version}`).join(', ')})</span>
                          </div>
                        ))
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="row wrap gap-s">
                      <Button small onClick={() => setEdit(e)}>
                        {t('Edit')}
                      </Button>
                      <Button small onClick={() => setHist(e)}>
                        {t('History')}
                      </Button>
                      <Button small variant="danger" onClick={() => del(e)}>
                        {t('Remove')}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {edit && <EditModal entry={edit} adminApi={adminApi} onClose={() => setEdit(null)} onSaved={reload} />}
      {hist && <HistoryModal entry={hist} adminApi={adminApi} onClose={() => setHist(null)} onSaved={reload} />}
    </div>
  );
}
