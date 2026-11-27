// Server administration (/admin): tables hosted on this server — create, rename, hide, archive, delete,
// GM password reset, backups (.zip download / restore), disk usage, admin password.
// Uses its own admin token (sessionless for tables), see server/lib/admin.js.
import { useEffect, useState, type FormEvent } from 'react';
import { Button, Panel, Field, Select, Toggle, Badge, Empty, LangSwitch, confirmAction, promptText } from '../../lib/ui.tsx';
import { api, setTableToken, uploadWithProgress, type ServerError } from '../../lib/net.ts';
import { toast, useLang } from '../../lib/ui-store.ts';
import { t, tn, tIfKnown, fmtDate } from '../../lib/i18n.js';
import { fmtBytes, Progress, type UploadProgress } from './common.tsx';
import BooksAdmin from './BooksAdmin.tsx';
import AssistantAdmin from './AssistantAdmin.tsx';
import MaplibAdmin from './MaplibAdmin.tsx';
import type { AdminApi, AdminPack, AdminTable, AdminTablesReply, RunFn } from './types.ts';

const TOKEN_KEY = 'sr.adminToken';
const readToken = () => {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
};
const writeToken = (tok: string) => {
  try {
    if (tok) sessionStorage.setItem(TOKEN_KEY, tok);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {}
};
let adminToken = readToken();

class AuthError extends Error {}
const adminApi: AdminApi = async (path, opts = {}) => {
  try {
    return await api(path, { ...opts, token: adminToken });
  } catch (err) {
    const e = err as ServerError;
    if (e.code === 'admin-auth' || e.key === 'Session administrateur expirée') throw new AuthError(e.message);
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
// Content packs: the server sends French labels (server/lib/tables.js PACKS), translated when they are dictionary keys.
const packLabel = (p: AdminPack): string => tIfKnown(p.label || p.id);
const packShort = (id: string) => (id === 'project-lazarus' ? 'Project Lazarus' : id === 'vierge' ? t('Vierge') : id);

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
      writeToken(r.token);
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
            <div className="muted">{t('Serveur Shadowrun')}</div>
          </div>
        </div>
        <label className="field">
          <span className="field-label">{t('Mot de passe administrateur')}</span>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </label>
        {err && <div className="error">{err}</div>}
        <Button variant="primary" type="submit" disabled={busy || !password}>
          {t('Se connecter')}
        </Button>
        <span className="field-hint">{t('Défini par la variable SR_ADMIN_PASSWORD du serveur (ou affiché une fois dans sa console au premier démarrage).')}</span>
        <a className="login-switch muted small" href="/?choisir">
          {t('← Retour aux tables')}
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
  const empty: CreateForm = { name: '', slug: '', pack: 'vierge', lang: 'fr', gmPassword: '', hidden: false };
  const [f, setF] = useState<CreateForm>(empty);
  const [slugTouched, setSlugTouched] = useState(false);
  const set = (patch: Partial<CreateForm>) => setF((cur) => ({ ...cur, ...patch }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await adminApi<{ table: { name: string } }>('/api/admin/tables', { method: 'POST', body: { ...f, slug: f.slug || slugify(f.name) } });
      toast(t('Table « {name} » créée', { name: r.table.name }), 'success');
      setF(empty);
      setSlugTouched(false);
      onCreated();
    });
  };
  return (
    <form className="admin-form" onSubmit={submit}>
      <Field label={t('Nom de la table')}>
        <input
          className="input"
          value={f.name}
          maxLength={80}
          placeholder={t('ex. Les Ombres de Lyon')}
          onChange={(e) => set({ name: e.target.value, ...(slugTouched ? {} : { slug: slugify(e.target.value) }) })}
        />
      </Field>
      <Field label={t('Identifiant (adresse)')} hint={f.slug ? t('Adresse : {url}', { url: `${location.origin}/t/${f.slug}/` }) : t('Lettres minuscules, chiffres et tirets')}>
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
      <Field label={t('Contenu de départ')}>
        <Select value={f.pack} options={packs.map((p) => ({ value: p.id, label: packLabel(p) }))} onChange={(v) => set({ pack: v })} />
      </Field>
      <Field label={t('Langue de la table')}>
        <Select value={f.lang} options={langs.map((l) => ({ value: l, label: LANG_LABEL[l] || l }))} onChange={(v) => set({ lang: v })} />
      </Field>
      <Field label={t('Mot de passe MJ')} hint={t('6 caractères minimum — à transmettre au MJ de la table.')}>
        <input className="input" type="text" autoComplete="off" value={f.gmPassword} onChange={(e) => set({ gmPassword: e.target.value })} />
      </Field>
      <Field label={t('Visibilité')}>
        <Toggle value={f.hidden} onChange={(v) => set({ hidden: v })} label={t('Masquer de l’accueil (accès par le lien seulement)')} />
      </Field>
      <div className="admin-form-actions">
        <Button variant="primary" type="submit" disabled={!f.name.trim() || f.gmPassword.length < 6}>
          {t('Créer la table')}
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
    if (replace && !(await confirmAction(t('Remplacer la table « {slug} » par cette sauvegarde ? L’actuelle est d’abord archivée en .zip sur le serveur.', { slug })))) return;
    const q = new URLSearchParams();
    if (slug) q.set('slug', slug);
    if (name) q.set('name', name);
    if (replace) q.set('replace', '1');
    setProgress(0);
    try {
      const r = await uploadWithProgress<{ table: { name: string } }>(`/api/admin/restore?${q}`, file, { token: adminToken, onProgress: (p) => setProgress(p >= 1 ? 'server' : p) });
      toast(t('Table « {name} » restaurée', { name: r.table.name }), 'success');
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
        {t('Envoie le .zip d’une table (bouton « Sauvegarde .zip » d’un serveur) ou l’export .json d’une partie (Réglages → Télécharger la partie). Taille max : {size}.', { size: fmtBytes(maxBytes) })}
      </p>
      <div className="admin-file">
        <label className="btn">
          {t('Choisir un fichier')}
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
          <span className="muted small">{t('Aucun fichier choisi')}</span>
        )}
      </div>
      <div className="admin-form">
        <Field label={t('Identifiant (optionnel)')} hint={t('Par défaut : celui de la sauvegarde.')}>
          <input className="input mono" value={slug} maxLength={40} onChange={(e) => setSlug(e.target.value.toLowerCase())} />
        </Field>
        <Field label={t('Nom (optionnel)')}>
          <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('Si l’identifiant existe déjà')}>
          <Toggle value={replace} onChange={setReplace} label={t('Remplacer la table existante')} />
        </Field>
      </div>
      {progress !== null && <Progress value={progress} serverLabel={t('Restauration sur le serveur…')} />}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button variant="primary" disabled={!file || progress !== null} onClick={submit}>
          {t('Restaurer')}
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
    if (next !== again) return toast(t('Les deux nouveaux mots de passe ne correspondent pas'), 'error');
    run(async () => {
      await adminApi('/api/admin/password', { method: 'POST', body: { current: cur, next } });
      toast(t('Mot de passe administrateur changé'), 'success');
      setCur('');
      setNext('');
      setAgain('');
    });
  };
  return (
    <form className="admin-form" onSubmit={submit}>
      <Field label={t('Mot de passe actuel')}>
        <input className="input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} />
      </Field>
      <Field label={t('Nouveau (8 caractères min.)')}>
        <input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label={t('Confirmation')}>
        <input className="input" type="password" value={again} onChange={(e) => setAgain(e.target.value)} />
      </Field>
      <div className="admin-form-actions">
        <span className="field-hint">{t('Si SR_ADMIN_PASSWORD change dans la configuration du serveur, elle reprend la main au redémarrage.')}</span>
        <Button type="submit" disabled={!cur || next.length < 8}>
          {t('Changer')}
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
    const name = await promptText(t('Nouveau nom de la table :'), tb.name);
    if (name && name.trim() && name.trim() !== tb.name) patch({ name: name.trim() }, t('Table renommée'));
  };
  const gmPassword = async () => {
    const pw = await promptText(t('Nouveau mot de passe MJ pour « {name} » (6 caractères minimum). Les MJ connectés devront se reconnecter.', { name: tb.name }));
    if (!pw) return;
    run(async () => {
      await adminApi(`/api/admin/tables/${tb.id}/gm-password`, { method: 'POST', body: { password: pw } });
      toast(t('Mot de passe MJ changé'), 'success');
    });
  };
  const openAsGm = () =>
    run(async () => {
      const r = await adminApi<{ slug: string; token: string; url: string }>(`/api/admin/tables/${tb.id}/gm-session`, { method: 'POST' });
      if (!setTableToken(r.slug, r.token)) return toast(t('Stockage du navigateur bloqué : connecte-toi avec le mot de passe MJ'), 'warn');
      window.open(r.url, '_blank');
    });
  const backup = () =>
    run(async () => {
      const r = await adminApi<{ url: string }>(`/api/admin/tables/${tb.id}/download`, { method: 'POST', body: {} });
      download(r.url);
    });
  const archive = async () => {
    if (!tb.archived && !(await confirmAction(t('Archiver « {name} » ? La table disparaît de l’accueil et les personnes connectées sont déconnectées. Rien n’est effacé.', { name: tb.name })))) return;
    patch({ archived: !tb.archived }, tb.archived ? t('Table désarchivée') : t('Table archivée'));
  };
  const remove = async () => {
    const typed = await promptText(
      t('Supprimer définitivement « {name} » ? Une archive .zip est gardée sur le serveur (dossier deleted/). Tape l’identifiant « {id} » pour confirmer :', { name: tb.name, id: tb.id })
    );
    if (typed === null) return;
    if (typed.trim() !== tb.id) return toast(t('Identifiant incorrect : rien n’a été supprimé'), 'warn');
    run(async () => {
      const r = await adminApi<{ backup: string }>(`/api/admin/tables/${tb.id}`, { method: 'DELETE', body: { confirm: tb.id } });
      toast(t('Table supprimée (archive : {file})', { file: r.backup }), 'success');
      reload();
    });
  };
  const usable = tb.status === 'open';
  return (
    <tr className={tb.archived ? 'archived' : ''}>
      <td>
        <div className="admin-name">{tb.name}</div>
        <div className="admin-badges">
          {tb.archived && <Badge color="amber">{t('archivée')}</Badge>}
          {tb.status === 'broken' && (
            <Badge color="red" title={tb.error}>
              {t('indisponible')}
            </Badge>
          )}
          {tb.hidden && <Badge>{t('masquée')}</Badge>}
          {tb.legacy && (
            <Badge color="cyan" title={t('Garde les adresses historiques /uploads et /assets/foundry')}>
              {t('historique')}
            </Badge>
          )}
          {tb.online > 0 && <Badge color="green">{t('{n} en ligne', { n: tb.online })}</Badge>}
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
      <td className="small">{tb.players === null ? '—' : t('{players} · {pcs}', { players: tn(tb.players, '{n} joueur', '{n} joueurs'), pcs: tn(tb.pcs, '{n} PJ', 'pluriel::{n} PJ') })}</td>
      <td className="small">{fmtDate(tb.lastActivity)}</td>
      <td className="num-cell small">{fmtBytes(tb.sizeBytes)}</td>
      <td>
        <div className="admin-actions">
          <Button small variant="primary" disabled={!usable} onClick={openAsGm} title={t('Ouvre la table en tant que MJ dans un nouvel onglet')}>
            {t('Ouvrir en MJ')}
          </Button>
          <Button small disabled={!usable} onClick={rename}>
            {t('Renommer')}
          </Button>
          <Button small disabled={!usable} onClick={gmPassword}>
            {t('Mot de passe MJ')}
          </Button>
          <Button small variant="ghost" disabled={tb.archived} onClick={() => patch({ hidden: !tb.hidden })}>
            {tb.hidden ? t('Afficher à l’accueil') : t('Masquer')}
          </Button>
          <Button small variant="ghost" onClick={() => patch({ lang: tb.lang === 'fr' ? 'en' : 'fr' }, t('Langue changée'))} disabled={!usable}>
            {tb.lang === 'fr' ? t('Passer en anglais') : t('Passer en français')}
          </Button>
          <Button small onClick={backup} title={t('Télécharge un .zip : partie, fichiers téléversés, documents')}>
            {t('Sauvegarde .zip')}
          </Button>
          <Button small variant="ghost" onClick={archive}>
            {tb.archived ? t('Désarchiver') : t('Archiver')}
          </Button>
          <Button small variant="danger" onClick={remove}>
            {t('Supprimer')}
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
    writeToken('');
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
        toast(t('Session administrateur expirée, reconnecte-toi'), 'warn');
      } else toast((err as Error).message || t('Erreur'), 'error');
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
          <span>{t('Administration du serveur')}</span>
        </div>
        {busy && <span className="muted small">…</span>}
        {onLang && <LangSwitch value={lang} onChange={onLang} />}
        <a className="btn btn-ghost btn-sm" href="/?choisir">
          {t('Accueil')}
        </a>
        <Button small variant="ghost" onClick={reload}>
          {t('Actualiser')}
        </Button>
        <Button small onClick={logout}>
          {t('Se déconnecter')}
        </Button>
      </header>
      <div className="admin-body">
        <div className="page">
          <div className="admin-stats">
            <div className="admin-stat">
              <strong>
                {tables.filter((x) => !x.archived).length} / {tables.length}
              </strong>
              <span className="muted small">{t('tables actives / total')}</span>
            </div>
            <div className="admin-stat">
              <strong>{tables.reduce((s, x) => s + (x.online || 0), 0)}</strong>
              <span className="muted small">{t('personnes connectées')}</span>
            </div>
            <div className="admin-stat">
              <strong>{fmtBytes(totalBytes)}</strong>
              <span className="muted small">{t('données des tables')}</span>
            </div>
            <div className="admin-stat">
              <strong>{fmtBytes(data?.sharedAssetsBytes || 0)}</strong>
              <span className="muted small">{t('fichiers Foundry partagés (historiques)')}</span>
            </div>
            {disk && (
              <div className={'admin-stat' + (freeRatio < 0.05 ? ' bad' : freeRatio < 0.15 ? ' warn' : '')}>
                <strong>{fmtBytes(disk.free)}</strong>
                <span className="muted small">{t('libres sur {total}', { total: fmtBytes(disk.total) })}</span>
              </div>
            )}
          </div>

          <h3 className="section-title">{t('Tables')}</h3>
          <Panel pad={false}>
            {!data ? (
              <Empty>{t('Chargement…')}</Empty>
            ) : tables.length ? (
              <div style={{ overflowX: 'auto' }}>
                <table className="sr admin-tables">
                  <thead>
                    <tr>
                      <th>{t('Table')}</th>
                      <th>{t('Adresse')}</th>
                      <th>{t('Contenu')}</th>
                      <th>{t('Joueurs')}</th>
                      <th>{t('Dernière activité')}</th>
                      <th className="right">{t('Taille')}</th>
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
              <Empty>{t('Aucune table : crée la première ci-dessous.')}</Empty>
            )}
          </Panel>

          <div className="grid-2" style={{ marginTop: 14 }}>
            <Panel title={t('Nouvelle table')}>{data && <CreateTable packs={data.packs} langs={data.langs} onCreated={reload} run={run} />}</Panel>
            <Panel title={t('Restaurer une table')}>{data && <RestoreTable maxBytes={data.maxUploadBytes} onDone={reload} />}</Panel>
          </div>

          <Panel title={t('Livres de règles')} style={{ marginTop: 14 }}>
            <BooksAdmin adminApi={adminApi} token={adminToken} run={run} />
          </Panel>
          <Panel title={t('Bibliothèque de cartes')} style={{ marginTop: 14 }}>
            <MaplibAdmin adminApi={adminApi} token={adminToken} run={run} />
          </Panel>
          <Panel title={t('Assistant IA')} style={{ marginTop: 14 }}>
            <AssistantAdmin adminApi={adminApi} run={run} />
          </Panel>

          <div className="grid-2" style={{ marginTop: 14 }}>
            <Panel title={t('Archives des tables supprimées ou remplacées')}>
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
                          {t('Télécharger')}
                        </Button>
                      </div>
                    ))}
                  </div>
                  <p className="field-hint">{t('Pour récupérer une table, télécharge son archive puis utilise « Restaurer une table ».')}</p>
                </>
              ) : (
                <Empty>{t('Aucune archive.')}</Empty>
              )}
            </Panel>
            <Panel title={t('Mot de passe administrateur')}>
              <AdminPassword run={run} />
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
}
