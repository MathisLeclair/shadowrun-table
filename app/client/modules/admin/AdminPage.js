// Server administration (/admin): tables hosted on this server — create, rename, hide, archive, delete,
// GM password reset, backups (.zip download / restore), disk usage, admin password.
// Uses its own admin token (sessionless for tables), see server/lib/admin.js.
import { useEffect, useState } from 'preact/hooks';
import { html, Button, Panel, Field, Select, Toggle, Badge, Empty, LangSwitch, confirmAction, promptText } from '../../lib/ui.js';
import { api, setTableToken, uploadWithProgress } from '../../lib/net.js';
import { toast, useLang } from '../../lib/ui-store.js';
import { t, tn, tIfKnown, fmtDate } from '../../lib/i18n.js';
import { fmtBytes, Progress } from './common.js';
import BooksAdmin from './BooksAdmin.js';

const TOKEN_KEY = 'sr.adminToken';
const readToken = () => {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
};
const writeToken = (tok) => {
  try {
    if (tok) sessionStorage.setItem(TOKEN_KEY, tok);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {}
};
let adminToken = readToken();

class AuthError extends Error {}
async function adminApi(path, opts = {}) {
  try {
    return await api(path, { ...opts, token: adminToken });
  } catch (err) {
    if (err.code === 'admin-auth' || err.key === 'Session administrateur expirée') throw new AuthError(err.message);
    throw err;
  }
}

const slugify = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
const LANG_LABEL = { fr: 'Français', en: 'English' }; // endonyms: never translated
// Content packs: the server sends French labels (server/lib/tables.js PACKS), translated when they are dictionary keys.
const packLabel = (p) => tIfKnown(p.label || p.id);
const packShort = (id) => (id === 'project-lazarus' ? 'Project Lazarus' : id === 'vierge' ? t('Vierge') : id);

/** Start a browser download from a one-time server URL. */
function download(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------------------------------------------------------------------------
function AdminLogin({ onDone, onLang }) {
  const lang = useLang();
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const r = await api('/api/admin/login', { method: 'POST', body: { password } });
      adminToken = r.token;
      writeToken(r.token);
      onDone();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="login">
    <form class="login-card admin-login" onSubmit=${submit}>
      ${onLang && html`<${LangSwitch} class="login-lang" value=${lang} onChange=${onLang} />`}
      <div class="login-logo">
        <div class="logo-mark"></div>
        <div><h1>${t('Administration')}</h1><div class="muted">${t('Serveur Shadowrun')}</div></div>
      </div>
      <label class="field"><span class="field-label">${t('Mot de passe administrateur')}</span>
        <input class="input" type="password" value=${password} onInput=${(e) => setPassword(e.target.value)} autofocus /></label>
      ${err && html`<div class="error">${err}</div>`}
      <${Button} variant="primary" type="submit" disabled=${busy || !password}>${t('Se connecter')}</${Button}>
      <span class="field-hint">${t('Défini par la variable SR_ADMIN_PASSWORD du serveur (ou affiché une fois dans sa console au premier démarrage).')}</span>
      <a class="login-switch muted small" href="/?choisir">${t('← Retour aux tables')}</a>
    </form>
  </div>`;
}

// ---------------------------------------------------------------------------
function CreateTable({ packs, langs, onCreated, run }) {
  const empty = { name: '', slug: '', pack: 'vierge', lang: 'fr', gmPassword: '', hidden: false };
  const [f, setF] = useState(empty);
  const [slugTouched, setSlugTouched] = useState(false);
  const set = (patch) => setF((cur) => ({ ...cur, ...patch }));
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await adminApi('/api/admin/tables', { method: 'POST', body: { ...f, slug: f.slug || slugify(f.name) } });
      toast(t('Table « {name} » créée', { name: r.table.name }), 'success');
      setF(empty);
      setSlugTouched(false);
      onCreated();
    });
  };
  return html`<form class="admin-form" onSubmit=${submit}>
    <${Field} label=${t('Nom de la table')}>
      <input class="input" value=${f.name} maxlength="80" placeholder=${t('ex. Les Ombres de Lyon')}
        onInput=${(e) => set({ name: e.target.value, ...(slugTouched ? {} : { slug: slugify(e.target.value) }) })} />
    </${Field}>
    <${Field} label=${t('Identifiant (adresse)')} hint=${f.slug ? t('Adresse : {url}', { url: `${location.origin}/t/${f.slug}/` }) : t('Lettres minuscules, chiffres et tirets')}>
      <input class="input mono" value=${f.slug} maxlength="40" onInput=${(e) => { setSlugTouched(true); set({ slug: e.target.value.toLowerCase() }); }} />
    </${Field}>
    <${Field} label=${t('Contenu de départ')}>
      <${Select} value=${f.pack} options=${packs.map((p) => ({ value: p.id, label: packLabel(p) }))} onChange=${(v) => set({ pack: v })} />
    </${Field}>
    <${Field} label=${t('Langue de la table')}>
      <${Select} value=${f.lang} options=${langs.map((l) => ({ value: l, label: LANG_LABEL[l] || l }))} onChange=${(v) => set({ lang: v })} />
    </${Field}>
    <${Field} label=${t('Mot de passe MJ')} hint=${t('6 caractères minimum — à transmettre au MJ de la table.')}>
      <input class="input" type="text" autocomplete="off" value=${f.gmPassword} onInput=${(e) => set({ gmPassword: e.target.value })} />
    </${Field}>
    <${Field} label=${t('Visibilité')}>
      <${Toggle} value=${f.hidden} onChange=${(v) => set({ hidden: v })} label=${t('Masquer de l’accueil (accès par le lien seulement)')} />
    </${Field}>
    <div class="admin-form-actions">
      <${Button} variant="primary" type="submit" disabled=${!f.name.trim() || f.gmPassword.length < 6}>${t('Créer la table')}</${Button}>
    </div>
  </form>`;
}

// ---------------------------------------------------------------------------
function RestoreTable({ maxBytes, onDone }) {
  const [file, setFile] = useState(null);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [replace, setReplace] = useState(false);
  const [progress, setProgress] = useState(null); // null | 0..1 | 'server'
  const submit = async () => {
    if (!file) return;
    if (replace && !(await confirmAction(t('Remplacer la table « {slug} » par cette sauvegarde ? L’actuelle est d’abord archivée en .zip sur le serveur.', { slug })))) return;
    const q = new URLSearchParams();
    if (slug) q.set('slug', slug);
    if (name) q.set('name', name);
    if (replace) q.set('replace', '1');
    setProgress(0);
    try {
      const r = await uploadWithProgress(`/api/admin/restore?${q}`, file, { token: adminToken, onProgress: (p) => setProgress(p >= 1 ? 'server' : p) });
      toast(t('Table « {name} » restaurée', { name: r.table.name }), 'success');
      setFile(null);
      setSlug('');
      setName('');
      setReplace(false);
      onDone();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setProgress(null);
    }
  };
  return html`<div class="col">
    <p class="muted small">${t('Envoie le .zip d’une table (bouton « Sauvegarde .zip » d’un serveur) ou l’export .json d’une partie (Réglages → Télécharger la partie). Taille max : {size}.', { size: fmtBytes(maxBytes) })}</p>
    <div class="admin-file">
      <label class="btn">${t('Choisir un fichier')}<input type="file" accept=".zip,.json" class="hidden" onChange=${(e) => { setFile(e.target.files[0] || null); e.target.value = ''; }} /></label>
      ${file ? html`<span class="mono small">${file.name} (${fmtBytes(file.size)})</span>` : html`<span class="muted small">${t('Aucun fichier choisi')}</span>`}
    </div>
    <div class="admin-form">
      <${Field} label=${t('Identifiant (optionnel)')} hint=${t('Par défaut : celui de la sauvegarde.')}>
        <input class="input mono" value=${slug} maxlength="40" onInput=${(e) => setSlug(e.target.value.toLowerCase())} />
      </${Field}>
      <${Field} label=${t('Nom (optionnel)')}>
        <input class="input" value=${name} maxlength="80" onInput=${(e) => setName(e.target.value)} />
      </${Field}>
      <${Field} label=${t('Si l’identifiant existe déjà')}>
        <${Toggle} value=${replace} onChange=${setReplace} label=${t('Remplacer la table existante')} />
      </${Field}>
    </div>
    ${progress !== null && html`<${Progress} value=${progress} serverLabel=${t('Restauration sur le serveur…')} />`}
    <div class="row" style="justify-content:flex-end">
      <${Button} variant="primary" disabled=${!file || progress !== null} onClick=${submit}>${t('Restaurer')}</${Button}>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
function AdminPassword({ run }) {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const submit = (e) => {
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
  return html`<form class="admin-form" onSubmit=${submit}>
    <${Field} label=${t('Mot de passe actuel')}><input class="input" type="password" value=${cur} onInput=${(e) => setCur(e.target.value)} /></${Field}>
    <${Field} label=${t('Nouveau (8 caractères min.)')}><input class="input" type="password" value=${next} onInput=${(e) => setNext(e.target.value)} /></${Field}>
    <${Field} label=${t('Confirmation')}><input class="input" type="password" value=${again} onInput=${(e) => setAgain(e.target.value)} /></${Field}>
    <div class="admin-form-actions">
      <span class="field-hint">${t('Si SR_ADMIN_PASSWORD change dans la configuration du serveur, elle reprend la main au redémarrage.')}</span>
      <${Button} type="submit" disabled=${!cur || next.length < 8}>${t('Changer')}</${Button}>
    </div>
  </form>`;
}

// ---------------------------------------------------------------------------
function TableRow({ tb, run, reload }) {
  const patch = (body, okMsg) =>
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
      const r = await adminApi(`/api/admin/tables/${tb.id}/gm-session`, { method: 'POST' });
      if (!setTableToken(r.slug, r.token)) return toast(t('Stockage du navigateur bloqué : connecte-toi avec le mot de passe MJ'), 'warn');
      window.open(r.url, '_blank');
    });
  const backup = () =>
    run(async () => {
      const r = await adminApi(`/api/admin/tables/${tb.id}/download`, { method: 'POST', body: {} });
      download(r.url);
    });
  const archive = async () => {
    if (!tb.archived && !(await confirmAction(t('Archiver « {name} » ? La table disparaît de l’accueil et les personnes connectées sont déconnectées. Rien n’est effacé.', { name: tb.name })))) return;
    patch({ archived: !tb.archived }, tb.archived ? t('Table désarchivée') : t('Table archivée'));
  };
  const remove = async () => {
    const typed = await promptText(t('Supprimer définitivement « {name} » ? Une archive .zip est gardée sur le serveur (dossier deleted/). Tape l’identifiant « {id} » pour confirmer :', { name: tb.name, id: tb.id }));
    if (typed === null) return;
    if (typed.trim() !== tb.id) return toast(t('Identifiant incorrect : rien n’a été supprimé'), 'warn');
    run(async () => {
      const r = await adminApi(`/api/admin/tables/${tb.id}`, { method: 'DELETE', body: { confirm: tb.id } });
      toast(t('Table supprimée (archive : {file})', { file: r.backup }), 'success');
      reload();
    });
  };
  const usable = tb.status === 'open';
  return html`<tr class=${tb.archived ? 'archived' : ''}>
    <td>
      <div class="admin-name">${tb.name}</div>
      <div class="admin-badges">
        ${tb.archived && html`<${Badge} color="amber">${t('archivée')}</${Badge}>`}
        ${tb.status === 'broken' && html`<${Badge} color="red" title=${tb.error}>${t('indisponible')}</${Badge}>`}
        ${tb.hidden && html`<${Badge}>${t('masquée')}</${Badge}>`}
        ${tb.legacy && html`<${Badge} color="cyan" title=${t('Garde les adresses historiques /uploads et /assets/foundry')}>${t('historique')}</${Badge}>`}
        ${tb.online > 0 && html`<${Badge} color="green">${t('{n} en ligne', { n: tb.online })}</${Badge}>`}
      </div>
    </td>
    <td>${usable ? html`<a class="mono small" href=${tb.url} target="_blank">${tb.url}</a>` : html`<span class="mono small muted">${tb.url}</span>`}</td>
    <td class="small">${packShort(tb.pack)} · ${LANG_LABEL[tb.lang] || tb.lang}</td>
    <td class="small">${tb.players === null ? '—' : t('{players} · {pcs}', { players: tn(tb.players, '{n} joueur', '{n} joueurs'), pcs: tn(tb.pcs, '{n} PJ', 'pluriel::{n} PJ') })}</td>
    <td class="small">${fmtDate(tb.lastActivity)}</td>
    <td class="num-cell small">${fmtBytes(tb.sizeBytes)}</td>
    <td>
      <div class="admin-actions">
        <${Button} small variant="primary" disabled=${!usable} onClick=${openAsGm} title=${t('Ouvre la table en tant que MJ dans un nouvel onglet')}>${t('Ouvrir en MJ')}</${Button}>
        <${Button} small disabled=${!usable} onClick=${rename}>${t('Renommer')}</${Button}>
        <${Button} small disabled=${!usable} onClick=${gmPassword}>${t('Mot de passe MJ')}</${Button}>
        <${Button} small variant="ghost" disabled=${tb.archived} onClick=${() => patch({ hidden: !tb.hidden })}>${tb.hidden ? t('Afficher à l’accueil') : t('Masquer')}</${Button}>
        <${Button} small variant="ghost" onClick=${() => patch({ lang: tb.lang === 'fr' ? 'en' : 'fr' }, t('Langue changée'))} disabled=${!usable}>${tb.lang === 'fr' ? t('Passer en anglais') : t('Passer en français')}</${Button}>
        <${Button} small onClick=${backup} title=${t('Télécharge un .zip : partie, fichiers téléversés, documents')}>${t('Sauvegarde .zip')}</${Button}>
        <${Button} small variant="ghost" onClick=${archive}>${tb.archived ? t('Désarchiver') : t('Archiver')}</${Button}>
        <${Button} small variant="danger" onClick=${remove}>${t('Supprimer')}</${Button}>
      </div>
    </td>
  </tr>`;
}

// ---------------------------------------------------------------------------
export default function AdminPage({ onLang }) {
  const lang = useLang();
  const [authed, setAuthed] = useState(!!adminToken);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  const logoutLocal = () => {
    adminToken = '';
    writeToken('');
    setAuthed(false);
    setData(null);
  };
  /** Run an admin call with a busy flag and error toasts; an expired session goes back to the login. */
  const run = async (fn) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      if (err instanceof AuthError) {
        logoutLocal();
        toast(t('Session administrateur expirée, reconnecte-toi'), 'warn');
      } else toast(err.message || t('Erreur'), 'error');
    } finally {
      setBusy(false);
    }
  };
  const reload = () => run(async () => setData(await adminApi('/api/admin/tables')));
  useEffect(() => {
    if (authed) reload();
  }, [authed]);
  useEffect(() => {
    document.title = t('Administration — Shadowrun');
  }, [lang]);

  if (!authed) return html`<${AdminLogin} onDone=${() => setAuthed(true)} onLang=${onLang} />`;

  const tables = data?.tables || [];
  const totalBytes = tables.reduce((s, x) => s + (x.sizeBytes || 0), 0);
  const disk = data?.disk;
  const freeRatio = disk ? disk.free / disk.total : 1;
  const logout = () => {
    api('/api/admin/logout', { method: 'POST', token: adminToken }).catch(() => {});
    logoutLocal();
  };

  return html`<div class="admin-shell">
    <header class="admin-top">
      <div class="brand"><div class="logo-mark small"></div><span>${t('Administration du serveur')}</span></div>
      ${busy && html`<span class="muted small">…</span>`}
      ${onLang && html`<${LangSwitch} value=${lang} onChange=${onLang} />`}
      <a class="btn btn-ghost btn-sm" href="/?choisir">${t('Accueil')}</a>
      <${Button} small variant="ghost" onClick=${reload}>${t('Actualiser')}</${Button}>
      <${Button} small onClick=${logout}>${t('Se déconnecter')}</${Button}>
    </header>
    <div class="admin-body">
      <div class="page">
        <div class="admin-stats">
          <div class="admin-stat"><strong>${tables.filter((x) => !x.archived).length} / ${tables.length}</strong><span class="muted small">${t('tables actives / total')}</span></div>
          <div class="admin-stat"><strong>${tables.reduce((s, x) => s + (x.online || 0), 0)}</strong><span class="muted small">${t('personnes connectées')}</span></div>
          <div class="admin-stat"><strong>${fmtBytes(totalBytes)}</strong><span class="muted small">${t('données des tables')}</span></div>
          <div class="admin-stat"><strong>${fmtBytes(data?.sharedAssetsBytes || 0)}</strong><span class="muted small">${t('fichiers Foundry partagés (historiques)')}</span></div>
          ${disk && html`<div class=${'admin-stat' + (freeRatio < 0.05 ? ' bad' : freeRatio < 0.15 ? ' warn' : '')}><strong>${fmtBytes(disk.free)}</strong><span class="muted small">${t('libres sur {total}', { total: fmtBytes(disk.total) })}</span></div>`}
        </div>

        <h3 class="section-title">${t('Tables')}</h3>
        <${Panel} pad=${false}>
          ${!data
            ? html`<${Empty}>${t('Chargement…')}</${Empty}>`
            : tables.length
              ? html`<div style="overflow-x:auto"><table class="sr admin-tables">
                  <thead><tr><th>${t('Table')}</th><th>${t('Adresse')}</th><th>${t('Contenu')}</th><th>${t('Joueurs')}</th><th>${t('Dernière activité')}</th><th class="right">${t('Taille')}</th><th></th></tr></thead>
                  <tbody>${tables.map((x) => html`<${TableRow} key=${x.id} tb=${x} run=${run} reload=${reload} />`)}</tbody>
                </table></div>`
              : html`<${Empty}>${t('Aucune table : crée la première ci-dessous.')}</${Empty}>`}
        </${Panel}>

        <div class="grid-2" style="margin-top:14px">
          <${Panel} title=${t('Nouvelle table')}>
            ${data && html`<${CreateTable} packs=${data.packs} langs=${data.langs} onCreated=${reload} run=${run} />`}
          </${Panel}>
          <${Panel} title=${t('Restaurer une table')}>
            ${data && html`<${RestoreTable} maxBytes=${data.maxUploadBytes} onDone=${reload} />`}
          </${Panel}>
        </div>

        <${Panel} title=${t('Livres de règles')} style="margin-top:14px">
          <${BooksAdmin} adminApi=${adminApi} token=${adminToken} run=${run} />
        </${Panel}>

        <div class="grid-2" style="margin-top:14px">
          <${Panel} title=${t('Archives des tables supprimées ou remplacées')}>
            ${data?.deleted?.length
              ? html`<div class="admin-worlds">${data.deleted.map(
                  (d) => html`<div class="admin-world">
                    <span class="mono">${d.file}</span><span class="muted small">${fmtBytes(d.size)}</span>
                    <span class="grow"></span>
                    <${Button} small onClick=${() => run(async () => download((await adminApi(`/api/admin/deleted/${encodeURIComponent(d.file)}/download`, { method: 'POST' })).url))}>${t('Télécharger')}</${Button}>
                  </div>`
                )}</div>
                <p class="field-hint">${t('Pour récupérer une table, télécharge son archive puis utilise « Restaurer une table ».')}</p>`
              : html`<${Empty}>${t('Aucune archive.')}</${Empty}>`}
          </${Panel}>
          <${Panel} title=${t('Mot de passe administrateur')}>
            <${AdminPassword} run=${run} />
          </${Panel}>
        </div>
      </div>
    </div>
  </div>`;
}
