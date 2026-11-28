// Server administration (/admin): tables hosted on this server — create, rename, hide, archive, delete,
// GM password reset, backups (.zip download / restore), disk usage, admin password.
// Uses its own admin token (sessionless for tables), see server/lib/admin.js.
import { useEffect, useState, type FormEvent } from 'react';
import { Button, Panel, Field, Select, Toggle, Badge, Empty, LangSwitch, confirmAction, promptText } from '../../lib/ui.tsx';
import { api, setTableToken, uploadWithProgress, type ServerError } from '../../lib/net.ts';
import { toast, useLang } from '../../lib/ui-store.ts';
import { t, tn, tIfKnown, fmtDate } from '../../lib/i18n.ts';
import { readAdminToken, writeAdminToken } from '../../lib/admin-token.ts';
import { fmtBytes, Progress, type UploadProgress } from './common.tsx';
import BooksAdmin from './BooksAdmin.tsx';
import AssistantAdmin from './AssistantAdmin.tsx';
import MaplibAdmin from './MaplibAdmin.tsx';
import type { AdminApi, AdminPack, AdminTable, AdminTablesReply, RunFn } from './types.ts';

let adminToken = readAdminToken();

class AuthError extends Error {}
const adminApi: AdminApi = async (path, opts = {}) => {
  try {
    return await api(path, { ...opts, token: adminToken });
  } catch (err) {
    const e = err as ServerError;
    if (e.code === 'admin-auth' || e.key === 'Administrator session expired') throw new AuthError(e.message);
    throw err;
  }
};

const slugify = (s: string) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
const LANG_LABEL: Record<string, string> = { fr: 'Français', en: 'English' }; // endonyms: never translated
// Content packs: the server sends labels (server/lib/tables.ts PACKS), translated when they are dictionary keys.
const packLabel = (p: AdminPack): string => tIfKnown(p.label || p.id);
const packShort = (id: string) => (id === 'project-lazarus' ? 'Project Lazarus' : id === 'blank' ? t('Blank') : id);

/** Start a browser download from a one-time server URL. */
function download(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------------------------------------------------------------------------
function AdminLogin({ onDone, onLang }: { onDone: () => void; onLang?: (l: string) => void }) {
  const lang = useLang();
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const r = await api<{ token: string }>('/api/admin/login', { method: 'POST', body: { password } });
      adminToken = r.token;
      writeAdminToken(r.token);
      onDone();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form className="login-card admin-login" onSubmit={submit}>
        {onLang && <LangSwitch className="login-lang" value={lang} onChange={onLang} />}
        <div className="login-logo">
          <div className="logo-mark"></div>
          <div>
            <h1>{t('Administration')}</h1>
            <div className="muted">{t('Shadowrun server')}</div>
          </div>
        </div>
        <label className="field">
          <span className="field-label">{t('Administrator password')}</span>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </label>
        {err && <div className="error">{err}</div>}
        <Button variant="primary" type="submit" disabled={busy || !password}>
          {t('Log in')}
        </Button>
        <span className="field-hint">{t('Set by the server\'s SR_ADMIN_PASSWORD variable (or printed once in its console on first start).')}</span>
        <a className="login-switch muted small" href="/?choisir">
          {t('← Back to the tables')}
        </a>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
interface CreateForm {
  name: string;
  slug: string;
  pack: string;
  lang: string;
  gmPassword: string;
  hidden: boolean;
}

function CreateTable({ packs, langs, onCreated, run }: { packs: AdminPack[]; langs: string[]; onCreated: () => void; run: RunFn }) {
  const empty: CreateForm = { name: '', slug: '', pack: 'blank', lang: 'fr', gmPassword: '', hidden: false };
  const [f, setF] = useState<CreateForm>(empty);
  const [slugTouched, setSlugTouched] = useState(false);
  const set = (patch: Partial<CreateForm>) => setF((cur) => ({ ...cur, ...patch }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await adminApi<{ table: { name: string } }>('/api/admin/tables', { method: 'POST', body: { ...f, slug: f.slug || slugify(f.name) } });
      toast(t('Table “{name}” created', { name: r.table.name }), 'success');
      setF(empty);
      setSlugTouched(false);
      onCreated();
    });
  };
  return (
    <form className="admin-form" onSubmit={submit}>
      <Field label={t('Table name')}>
        <input
          className="input"
          value={f.name}
          maxLength={80}
          placeholder={t('e.g. Shadows of Lyon')}
          onChange={(e) => set({ name: e.target.value, ...(slugTouched ? {} : { slug: slugify(e.target.value) }) })}
        />
      </Field>
      <Field label={t('Identifier (address)')} hint={f.slug ? t('Address: {url}', { url: `${location.origin}/t/${f.slug}/` }) : t('Lowercase letters, digits and dashes')}>
        <input
          className="input mono"
          value={f.slug}
          maxLength={40}
          onChange={(e) => {
            setSlugTouched(true);
            set({ slug: e.target.value.toLowerCase() });
          }}
        />
      </Field>
      <Field label={t('Starting content')}>
        <Select value={f.pack} options={packs.map((p) => ({ value: p.id, label: packLabel(p) }))} onChange={(v) => set({ pack: v })} />
      </Field>
      <Field label={t('Table language')}>
        <Select value={f.lang} options={langs.map((l) => ({ value: l, label: LANG_LABEL[l] || l }))} onChange={(v) => set({ lang: v })} />
      </Field>
      <Field label={t('GM password')} hint={t('6 characters minimum — give it to the table\'s GM.')}>
        <input className="input" type="text" autoComplete="off" value={f.gmPassword} onChange={(e) => set({ gmPassword: e.target.value })} />
      </Field>
      <Field label={t('Visibility')}>
        <Toggle value={f.hidden} onChange={(v) => set({ hidden: v })} label={t('Hide from the home page (access by link only)')} />
      </Field>
      <div className="admin-form-actions">
        <Button variant="primary" type="submit" disabled={!f.name.trim() || f.gmPassword.length < 6}>
          {t('Create the table')}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
function RestoreTable({ maxBytes, onDone }: { maxBytes: number; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [replace, setReplace] = useState(false);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const submit = async () => {
    if (!file) return;
    if (replace && !(await confirmAction(t('Replace table “{slug}” with this backup? The current one is first archived as a .zip on the server.', { slug })))) return;
    const q = new URLSearchParams();
    if (slug) q.set('slug', slug);
    if (name) q.set('name', name);
    if (replace) q.set('replace', '1');
    setProgress(0);
    try {
      const r = await uploadWithProgress<{ table: { name: string } }>(`/api/admin/restore?${q}`, file, { token: adminToken, onProgress: (p) => setProgress(p >= 1 ? 'server' : p) });
      toast(t('Table “{name}” restored', { name: r.table.name }), 'success');
      setFile(null);
      setSlug('');
      setName('');
      setReplace(false);
      onDone();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setProgress(null);
    }
  };
  return (
    <div className="col">
      <p className="muted small">
        {t('Upload a table\'s .zip (a server\'s “.zip backup” button) or a game\'s .json export (Settings → Download the game). Max size: {size}.', { size: fmtBytes(maxBytes) })}
      </p>
      <div className="admin-file">
        <label className="btn">
          {t('Choose a file')}
          <input
            type="file"
            accept=".zip,.json"
            className="hidden"
            onChange={(e) => {
              setFile(e.target.files?.[0] || null);
              e.target.value = '';
            }}
          />
        </label>
        {file ? (
          <span className="mono small">
            {file.name} ({fmtBytes(file.size)})
          </span>
        ) : (
          <span className="muted small">{t('No file chosen')}</span>
        )}
      </div>
      <div className="admin-form">
        <Field label={t('Identifier (optional)')} hint={t('Default: the backup\'s own.')}>
          <input className="input mono" value={slug} maxLength={40} onChange={(e) => setSlug(e.target.value.toLowerCase())} />
        </Field>
        <Field label={t('Name (optional)')}>
          <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('If the identifier already exists')}>
          <Toggle value={replace} onChange={setReplace} label={t('Replace the existing table')} />
        </Field>
      </div>
      {progress !== null && <Progress value={progress} serverLabel={t('Restoring on the server…')} />}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="primary" disabled={!file || progress !== null} onClick={submit}>
          {t('Restore')}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function AdminPassword({ run }: { run: RunFn }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (next !== again) return toast(t('The two new passwords do not match'), 'error');
    run(async () => {
      await adminApi('/api/admin/password', { method: 'POST', body: { current: cur, next } });
      toast(t('Administrator password changed'), 'success');
      setCur('');
      setNext('');
      setAgain('');
    });
  };
  return (
    <form className="admin-form" onSubmit={submit}>
      <Field label={t('Current password')}>
        <input className="input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} />
      </Field>
      <Field label={t('New (8 characters min.)')}>
        <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label={t('Confirmation')}>
        <input className="input" type="password" value={again} onChange={(e) => setAgain(e.target.value)} />
      </Field>
      <div className="admin-form-actions">
        <span className="field-hint">{t('If SR_ADMIN_PASSWORD changes in the server configuration, it takes over again on restart.')}</span>
        <Button type="submit" disabled={!cur || next.length < 8}>
          {t('Change')}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
function TableRow({ tb, run, reload }: { tb: AdminTable; run: RunFn; reload: () => void }) {
  const patch = (body: object, okMsg?: string) =>
    run(async () => {
      await adminApi(`/api/admin/tables/${tb.id}`, { method: 'PATCH', body });
      if (okMsg) toast(okMsg, 'success');
      reload();
    });
  const rename = async () => {
    const name = await promptText(t('New table name:'), tb.name);
    if (name && name.trim() && name.trim() !== tb.name) patch({ name: name.trim() }, t('Table renamed'));
  };
  const gmPassword = async () => {
    const pw = await promptText(t('New GM password for “{name}” (6 characters minimum). Logged-in GMs will have to log in again.', { name: tb.name }));
    if (!pw) return;
    run(async () => {
      await adminApi(`/api/admin/tables/${tb.id}/gm-password`, { method: 'POST', body: { password: pw } });
      toast(t('GM password changed'), 'success');
    });
  };
  const openAsGm = () =>
    run(async () => {
      const r = await adminApi<{ slug: string; token: string; url: string }>(`/api/admin/tables/${tb.id}/gm-session`, { method: 'POST' });
      if (!setTableToken(r.slug, r.token)) return toast(t('Browser storage is blocked: log in with the GM password'), 'warn');
      window.open(r.url, '_blank');
    });
  const backup = () =>
    run(async () => {
      const r = await adminApi<{ url: string }>(`/api/admin/tables/${tb.id}/download`, { method: 'POST', body: {} });
      download(r.url);
    });
  const archive = async () => {
    if (!tb.archived && !(await confirmAction(t('Archive “{name}”? The table disappears from the home page and connected people are logged out. Nothing is deleted.', { name: tb.name })))) return;
    patch({ archived: !tb.archived }, tb.archived ? t('Table unarchived') : t('Table archived'));
  };
  const remove = async () => {
    const typed = await promptText(
      t('Permanently delete “{name}”? A .zip archive is kept on the server (deleted/ folder). Type the identifier “{id}” to confirm:', { name: tb.name, id: tb.id })
    );
    if (typed === null) return;
    if (typed.trim() !== tb.id) return toast(t('Wrong identifier: nothing was deleted'), 'warn');
    run(async () => {
      const r = await adminApi<{ backup: string }>(`/api/admin/tables/${tb.id}`, { method: 'DELETE', body: { confirm: tb.id } });
      toast(t('Table deleted (archive: {file})', { file: r.backup }), 'success');
      reload();
    });
  };
  const usable = tb.status === 'open';
  return (
    <tr className={tb.archived ? 'archived' : ''}>
      <td>
        <div className="admin-name">{tb.name}</div>
        <div className="admin-badges">
          {tb.archived && <Badge color="amber">{t('archived')}</Badge>}
          {tb.status === 'broken' && (
            <Badge color="red" title={tb.error}>
              {t('unavailable')}
            </Badge>
          )}
          {tb.hidden && <Badge>{t('fem::hidden')}</Badge>}
          {tb.legacy && (
            <Badge color="cyan" title={t('Keeps the historical /uploads and /assets/foundry addresses')}>
              {t('legacy')}
            </Badge>
          )}
          {tb.online > 0 && <Badge color="green">{t('{n} online', { n: tb.online })}</Badge>}
        </div>
      </td>
      <td>
        {usable ? (
          <a className="mono small" href={tb.url} target="_blank">
            {tb.url}
          </a>
        ) : (
          <span className="mono small muted">{tb.url}</span>
        )}
      </td>
      <td className="small">
        {packShort(tb.pack)} · {LANG_LABEL[tb.lang] || tb.lang}
      </td>
      <td className="small">{tb.players === null ? '—' : t('{players} · {pcs}', { players: tn(tb.players, '{n} player', '{n} players'), pcs: tn(tb.pcs, '{n} PC', 'plural::{n} PCs') })}</td>
      <td className="small">{fmtDate(tb.lastActivity)}</td>
      <td className="num-cell small">{fmtBytes(tb.sizeBytes)}</td>
      <td>
        <div className="admin-actions">
          <Button small variant="primary" disabled={!usable} onClick={openAsGm} title={t('Opens the table as GM in a new tab')}>
            {t('Open as GM')}
          </Button>
          <Button small disabled={!usable} onClick={rename}>
            {t('Rename')}
          </Button>
          <Button small disabled={!usable} onClick={gmPassword}>
            {t('GM password')}
          </Button>
          <Button small variant="ghost" disabled={tb.archived} onClick={() => patch({ hidden: !tb.hidden })}>
            {tb.hidden ? t('Show on the home page') : t('Hide')}
          </Button>
          <Button small variant="ghost" onClick={() => patch({ lang: tb.lang === 'fr' ? 'en' : 'fr' }, t('Language changed'))} disabled={!usable}>
            {tb.lang === 'fr' ? t('Switch to English') : t('Switch to French')}
          </Button>
          <Button small onClick={backup} title={t('Downloads a .zip: game, uploaded files, documents')}>
            {t('.zip backup')}
          </Button>
          <Button small variant="ghost" onClick={archive}>
            {tb.archived ? t('Unarchive') : t('Archive')}
          </Button>
          <Button small variant="danger" onClick={remove}>
            {t('Delete')}
          </Button>
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
export default function AdminPage({ onLang }: { onLang?: (l: string) => void }) {
  const lang = useLang();
  const [authed, setAuthed] = useState(!!adminToken);
  const [data, setData] = useState<AdminTablesReply | null>(null);
  const [busy, setBusy] = useState(false);

  const logoutLocal = () => {
    adminToken = '';
    writeAdminToken('');
    setAuthed(false);
    setData(null);
  };
  /** Run an admin call with a busy flag and error toasts; an expired session goes back to the login. */
  const run: RunFn = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      if (err instanceof AuthError) {
        logoutLocal();
        toast(t('Administrator session expired, please log in again'), 'warn');
      } else toast((err as Error).message || t('Error'), 'error');
    } finally {
      setBusy(false);
    }
  };
  const reload = () => run(async () => setData(await adminApi<AdminTablesReply>('/api/admin/tables')));
  useEffect(() => {
    if (authed) reload();
  }, [authed]);
  useEffect(() => {
    document.title = t('Administration — Shadowrun');
  }, [lang]);

  if (!authed) return <AdminLogin onDone={() => setAuthed(true)} onLang={onLang} />;

  const tables = data?.tables || [];
  const totalBytes = tables.reduce((s, x) => s + (x.sizeBytes || 0), 0);
  const disk = data?.disk;
  const freeRatio = disk ? disk.free / disk.total : 1;
  const logout = () => {
    api('/api/admin/logout', { method: 'POST', token: adminToken }).catch(() => {});
    logoutLocal();
  };

  return (
    <div className="admin-shell">
      <header className="admin-top">
        <div className="brand">
          <div className="logo-mark small"></div>
          <span>{t('Server administration')}</span>
        </div>
        {busy && <span className="muted small">…</span>}
        {onLang && <LangSwitch value={lang} onChange={onLang} />}
        <a className="btn btn-ghost btn-sm" href="/?choisir">
          {t('Home')}
        </a>
        <Button small variant="ghost" onClick={reload}>
          {t('Refresh')}
        </Button>
        <Button small onClick={logout}>
          {t('Log out')}
        </Button>
      </header>
      <div className="admin-body">
        <div className="page">
          <div className="admin-stats">
            <div className="admin-stat">
              <strong>
                {tables.filter((x) => !x.archived).length} / {tables.length}
              </strong>
              <span className="muted small">{t('active tables / total')}</span>
            </div>
            <div className="admin-stat">
              <strong>{tables.reduce((s, x) => s + (x.online || 0), 0)}</strong>
              <span className="muted small">{t('people online')}</span>
            </div>
            <div className="admin-stat">
              <strong>{fmtBytes(totalBytes)}</strong>
              <span className="muted small">{t('table data')}</span>
            </div>
            <div className="admin-stat">
              <strong>{fmtBytes(data?.sharedAssetsBytes || 0)}</strong>
              <span className="muted small">{t('shared Foundry files (legacy)')}</span>
            </div>
            {disk && (
              <div className={'admin-stat' + (freeRatio < 0.05 ? ' bad' : freeRatio < 0.15 ? ' warn' : '')}>
                <strong>{fmtBytes(disk.free)}</strong>
                <span className="muted small">{t('free of {total}', { total: fmtBytes(disk.total) })}</span>
              </div>
            )}
          </div>

          <h3 className="section-title">{t('Tables')}</h3>
          <Panel pad={false}>
            {!data ? (
              <Empty>{t('Loading…')}</Empty>
            ) : tables.length ? (
              <div style={{ overflowX: 'auto' }}>
                <table className="sr admin-tables">
                  <thead>
                    <tr>
                      <th>{t('Table')}</th>
                      <th>{t('Address')}</th>
                      <th>{t('Content')}</th>
                      <th>{t('Players')}</th>
                      <th>{t('Last activity')}</th>
                      <th className="right">{t('Size')}</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {tables.map((x) => (
                      <TableRow key={x.id} tb={x} run={run} reload={reload} />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>{t('No tables: create the first one below.')}</Empty>
            )}
          </Panel>

          <div className="grid-2" style={{ marginTop: 14 }}>
            <Panel title={t('New table')}>{data && <CreateTable packs={data.packs} langs={data.langs} onCreated={reload} run={run} />}</Panel>
            <Panel title={t('Restore a table')}>{data && <RestoreTable maxBytes={data.maxUploadBytes} onDone={reload} />}</Panel>
          </div>

          <Panel title={t('Rulebooks')} style={{ marginTop: 14 }}>
            <BooksAdmin adminApi={adminApi} token={adminToken} run={run} />
          </Panel>
          <Panel title={t('Map library')} style={{ marginTop: 14 }}>
            <MaplibAdmin adminApi={adminApi} token={adminToken} run={run} />
          </Panel>
          <Panel title={t('AI assistant')} style={{ marginTop: 14 }}>
            <AssistantAdmin adminApi={adminApi} run={run} />
          </Panel>

          <div className="grid-2" style={{ marginTop: 14 }}>
            <Panel title={t('Archives of deleted or replaced tables')}>
              {data?.deleted?.length ? (
                <>
                  <div className="admin-worlds">
                    {data.deleted.map((d) => (
                      <div className="admin-world" key={d.file}>
                        <span className="mono">{d.file}</span>
                        <span className="muted small">{fmtBytes(d.size)}</span>
                        <span className="grow"></span>
                        <Button
                          small
                          onClick={() => run(async () => download((await adminApi<{ url: string }>(`/api/admin/deleted/${encodeURIComponent(d.file)}/download`, { method: 'POST' })).url))}
                        >
                          {t('Download')}
                        </Button>
                      </div>
                    ))}
                  </div>
                  <p className="field-hint">{t('To recover a table, download its archive then use “Restore a table”.')}</p>
                </>
              ) : (
                <Empty>{t('No archives.')}</Empty>
              )}
            </Panel>
            <Panel title={t('Administrator password')}>
              <AdminPassword run={run} />
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}
