// App shell: table picker (/), admin page (/admin), and for a table (/t/<slug>/): login screen, header + main tabs,
// right dock, sheet modal, toasts, global components. Dictionaries are loaded before the first render (no French
// flash in an English session); a language switch re-renders the whole tree (see ARCHITECTURE.md « i18n »).
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { html, Button, Badge, Modal, Tabs, LangSwitch, loadCss } from './lib/ui.js';
import { connect, getToken, setToken, useGame, useConnected, logout, api, send, TABLE } from './lib/net.js';
import { useUI, setUI, toast, useLang } from './lib/ui-store.js';
import { t, tn, errorText, getLang, setLang, isLang, storedLang, storeLang, browserLang, expectUserLang, loadDictionaries } from './lib/i18n.js';
import { mainTabs, dockTabs, SheetView, globalComponents } from './modules/registry.js';

loadCss('/modules/admin/admin.css'); // table picker + admin page + login extras
loadCss('/modules/core/core.css'); // language switch, translation tools

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
// Guarded storage access: blocked site storage must not blank the page or fail a successful login.
const lsGet = (k) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k, v) => {
  try {
    localStorage.setItem(k, v);
    return true;
  } catch {
    return false;
  }
};

// Lobby of this table ({ campaignName, table: { lang… }, pcs }): fetched once at boot (initial language) and
// reused by the first login screen; later login screens fetch it again (fresh claimed-by list).
const fetchLobby = () =>
  fetch(`/api/lobby?table=${encodeURIComponent(TABLE || '')}`)
    .then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
    .catch(() => null);
let bootLobby = TABLE ? fetchLobby() : null;
const takeLobby = () => {
  const p = bootLobby || fetchLobby();
  bootLobby = null;
  return p;
};

/** Language switch before login: remembered in this browser, sent with the login. */
function pickLangLoggedOut(l) {
  storeLang(l);
  setLang(l);
}
/** Language switch of a logged-in user: applied at once, stored on the server (game.me.lang) and in this browser. */
function pickLangLoggedIn(l) {
  storeLang(l);
  expectUserLang(l);
  setLang(l);
  send('users/setLang', { lang: l }, { silent: true }).catch(() => {});
}

function Login({ onDone }) {
  const lang = useLang();
  const [lobby, setLobby] = useState(null);
  const [mode, setMode] = useState('player');
  const [name, setName] = useState(lsGet('sr.lastName') || '');
  const [pin, setPin] = useState('');
  const [characterId, setCharacterId] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [closed, setClosed] = useState(null); // table unknown / archived: no login form
  const demo = !!lobby?.table?.demo; // public demo table: no GM password, no PIN, PCs can be shared

  useEffect(() => {
    takeLobby().then((r) => {
      if (!r) return setErr(t('Serveur injoignable'));
      if (!r.ok) return setClosed(errorText(r.data, 'Table introuvable'));
      setLobby(r.data);
      if (r.data.campaignName) document.title = t('{name} — Shadowrun', { name: r.data.campaignName });
    });
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    try {
      const chosen = storedLang(); // only an explicit choice is saved on the account; otherwise the table's language applies
      const body = mode === 'gm' ? { role: 'gm', password, table: TABLE } : { role: 'player', name, pin: demo ? '' : pin, characterId, table: TABLE };
      if (chosen) body.lang = chosen;
      const res = await api('/api/login', { method: 'POST', body });
      if (mode === 'player') lsSet('sr.lastName', name);
      if (!setToken(res.token)) toast(t('Stockage du navigateur bloqué : la session ne survivra pas à un rechargement'), 'warn');
      onDone();
    } catch (e2) {
      setErr(e2.message);
    }
  };

  const langSwitch = html`<${LangSwitch} class="login-lang" value=${lang} onChange=${pickLangLoggedOut} />`;

  if (closed) {
    return html`<div class="login">
      <div class="login-card">
        ${langSwitch}
        <div class="login-logo"><div class="logo-mark"></div><div><h1>Shadowrun</h1><div class="muted">${t('Table « {slug} »', { slug: TABLE })}</div></div></div>
        <div class="error">${closed}</div>
        <a class="btn btn-primary" href="/?choisir">${t('Voir les tables disponibles')}</a>
      </div>
    </div>`;
  }

  return html`<div class="login">
    <form class="login-card" onSubmit=${submit}>
      ${langSwitch}
      <div class="login-logo">
        <div class="logo-mark"></div>
        <div><h1>${lobby?.campaignName || 'Shadowrun'}</h1><div class="muted">${t('Shadowrun 5E — Seattle, 2080')}</div></div>
      </div>
      ${demo &&
      html`<div class="demo-banner">
        <strong>${t('Table de démonstration publique')}</strong>
        <span>${t('Entre comme MJ ou comme joueur, sans mot de passe. Tout ce qui se passe ici est visible par les autres visiteurs et effacé à la remise à zéro (chaque nuit, et après 30 minutes sans personne).')}</span>
        <span class="muted small">${t('Astuce : ouvre la table dans une fenêtre de navigation privée pour jouer en même temps côté joueur.')}</span>
      </div>`}
      <${Tabs} tabs=${[{ id: 'player', label: t('Joueur') }, { id: 'gm', label: t('Maître de jeu') }]} value=${mode} onChange=${setMode} />
      ${mode === 'gm'
        ? demo
          ? html`<div class="muted">${t('Pas de mot de passe sur la démo : entre directement comme MJ.')}</div>`
          : html`<label class="field"><span class="field-label">${t('Mot de passe MJ')}</span>
            <input class="input" type="password" value=${password} onInput=${(e) => setPassword(e.target.value)} autofocus /></label>`
        : html`
          <label class="field"><span class="field-label">${t('Ton nom')}</span>
            <input class="input" value=${name} onInput=${(e) => setName(e.target.value)} placeholder=${t('ex. Baptiste')} autofocus /></label>
          ${!demo &&
          html`<label class="field"><span class="field-label">${t('Code PIN (optionnel, protège ton accès)')}</span>
            <input class="input" type="password" inputmode="numeric" value=${pin} onInput=${(e) => setPin(e.target.value)} /></label>`}
          <div class="field"><span class="field-label">${t('Ton personnage')}</span>
            <div class="pc-pick">
              ${(lobby?.pcs || []).map(
                (pc) => html`<button type="button" class=${'pc-choice' + (characterId === pc.id ? ' active' : '')}
                    disabled=${!demo && pc.claimedBy && pc.claimedBy.toLowerCase() !== name.trim().toLowerCase()}
                    onClick=${() => setCharacterId(characterId === pc.id ? '' : pc.id)}>
                  <strong>${pc.name}</strong>
                  <span class="muted">${pc.claimedBy ? t('joué par {name}', { name: pc.claimedBy }) : pc.player || t('libre')}</span>
                </button>`
              )}
              ${lobby && !lobby.pcs.length && html`<div class="muted">${t('Aucun personnage pour l’instant — le MJ pourra t’en attribuer un.')}</div>`}
            </div>
          </div>`}
      ${err && html`<div class="error">${err}</div>`}
      <${Button} variant="primary" type="submit">${t('Entrer dans la partie')}</${Button}>
      <a class="login-switch muted small" href="/?choisir">${t('← Changer de table')}</a>
    </form>
  </div>`;
}

// ---------------------------------------------------------------------------
// Main shell
// ---------------------------------------------------------------------------
function Shell() {
  const game = useGame();
  const ui = useUI();
  const online = useConnected();
  const lang = useLang();
  const tableName = game?.config?.campaignName;
  useEffect(() => {
    if (tableName) document.title = t('{name} — Shadowrun', { name: tableName });
  }, [tableName, lang]);
  // A language picked in this browser (login screen, another table) but not yet on this account: save it.
  const hasOwnLang = !!game?.me?.lang;
  useEffect(() => {
    const chosen = storedLang();
    if (game && !hasOwnLang && chosen && chosen !== game.config?.lang) send('users/setLang', { lang: chosen }, { silent: true }).catch(() => {});
  }, [!!game, hasOwnLang]);
  if (!game) return html`<div class="loading">${t('Connexion à la Matrice…')}</div>`;
  const role = game.me.role;
  const tabs = mainTabs.filter((tb) => tb.roles.includes(role));
  const docks = dockTabs.filter((tb) => tb.roles.includes(role));
  const current = tabs.find((tb) => tb.id === ui.mainTab) || tabs[0];
  const dock = docks.find((tb) => tb.id === ui.dockTab) || docks[0];
  const Main = current.component;
  const Dock = dock?.component;

  // key=lang on the page, dock and sheet: a language switch remounts them, so nothing cached keeps the old language.
  return html`<div class=${'shell' + (ui.dockOpen ? '' : ' dock-closed')}>
    <header class="topbar">
      <div class="brand" title=${t('Table : {slug}', { slug: game.config.table?.slug || TABLE || '' })}><div class="logo-mark small"></div><span>${game.config.campaignName}</span></div>
      <nav class="main-tabs">
        ${tabs.map((tb) => {
          const badge = tb.badge ? tb.badge(game) : null;
          return html`<button class=${'main-tab' + (tb.id === current.id ? ' active' : '')} onClick=${() => setUI({ mainTab: tb.id })}>
            <span class="tab-icon">${tb.icon}</span><span class="tab-label">${t(tb.label)}</span>${badge ? html`<span class="tab-badge">${badge}</span>` : null}
          </button>`;
        })}
      </nav>
      <div class="topbar-right">
        <${LangSwitch} value=${lang} onChange=${pickLangLoggedIn} />
        <span class=${'conn ' + (online ? 'on' : 'off')} title=${online ? t('Connecté') : t('Déconnecté — reconnexion…')}></span>
        <${Badge} color=${role === 'gm' ? 'magenta' : 'cyan'}>${role === 'gm' ? t('MJ') : game.me.name}</${Badge}>
        <button class="icon-btn" title=${ui.dockOpen ? t('Masquer le panneau') : t('Afficher le panneau')} onClick=${() => setUI({ dockOpen: !ui.dockOpen })}>${ui.dockOpen ? '⇥' : '⇤'}</button>
        <button class="icon-btn" title=${t('Se déconnecter')} onClick=${logout}>⏻</button>
      </div>
    </header>
    ${game.ui?.announcement && html`<div class="announcement">${game.ui.announcement}</div>`}
    <main class="main"><${Main} key=${lang} game=${game} /></main>
    ${ui.dockOpen &&
    Dock &&
    html`<aside class="dock">
      <${Tabs} class="dock-tabs" tabs=${docks.map((d) => ({ id: d.id, label: t(d.label), badge: d.badge ? d.badge(game) : null }))} value=${dock.id} onChange=${(id) => setUI({ dockTab: id })} />
      <div class="dock-body"><${Dock} key=${lang} game=${game} /></div>
    </aside>`}
    ${ui.sheetActorId &&
    game.actors[ui.sheetActorId] &&
    html`<${Modal} title=${game.actors[ui.sheetActorId].name} width=${1100} onClose=${() => setUI({ sheetActorId: null })}>
      <${SheetView} key=${lang} game=${game} actorId=${ui.sheetActorId} />
    </${Modal}>`}
    ${globalComponents.map((C) => html`<${C} game=${game} />`)}
  </div>`;
}

function Toasts() {
  const ui = useUI();
  return html`<div class="toasts">${ui.toasts.map((tt) => html`<div class=${'toast toast-' + tt.kind}>${tt.text}</div>`)}</div>`;
}

function App() {
  useLang(); // re-render the whole tree on a language switch
  const [authed, setAuthed] = useState(!!getToken());
  useEffect(() => {
    if (!authed) return;
    let done = false;
    const s = connect((info) => {
      if (done) return;
      done = true;
      setToken(null);
      setAuthed(false);
      if (info?.reason === 'demo-reset') toast(t('La table de démonstration vient d’être remise à zéro : reconnecte-toi'), 'warn');
      else toast(t('Session expirée, reconnecte-toi'), 'warn');
    });
    return () => s.disconnect();
  }, [authed]);
  return html`${authed ? html`<${Shell} />` : html`<${Login} onDone=${() => setAuthed(true)} />`}<${Toasts} />`;
}

// ---------------------------------------------------------------------------
// Table picker (/): the tables hosted on this server
// ---------------------------------------------------------------------------
function TablePicker() {
  const lang = useLang();
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    fetch('/api/tables')
      .then((r) => r.json())
      .then((j) => setList(j.tables || []))
      .catch(() => setErr(t('Serveur injoignable')));
  }, []);
  useEffect(() => {
    document.title = t('Shadowrun — Choisis ta table');
  }, [lang]);
  return html`<div class="login">
    <div class="login-card picker-card">
      <${LangSwitch} class="login-lang" value=${lang} onChange=${pickLangLoggedOut} />
      <div class="login-logo">
        <div class="logo-mark"></div>
        <div><h1>Shadowrun</h1><div class="muted">${t('Choisis ta table')}</div></div>
      </div>
      ${err && html`<div class="error">${err}</div>`}
      ${!list && !err && html`<div class="muted">${t('Chargement…')}</div>`}
      ${list && !list.length && html`<div class="muted">${t('Aucune table ouverte pour l’instant.')}</div>`}
      ${list?.length > 0 &&
      html`<div class="picker-list">
        ${list.map(
          (tb) => html`<a class="picker-table" href=${`/t/${tb.slug}/`}>
            <span class="picker-name">${tb.name}${tb.demo ? html` <span class="demo-pill">${t('démo')}</span>` : null}</span>
            <span class="muted small">${tb.online ? tn(tb.online, '{n} connecté', '{n} connectés') : t('personne en ligne')}${isLang(tb.lang) ? ` · ${tb.lang.toUpperCase()}` : ''}</span>
            <span class="btn btn-primary btn-sm">${t('Rejoindre')}</span>
          </a>`
        )}
      </div>`}
      <a class="login-switch muted small" href="/admin">${t('Administration du serveur')}</a>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Admin page (/admin) — loaded on demand
// ---------------------------------------------------------------------------
function AdminRoot() {
  useLang(); // re-render the whole tree on a language switch
  const [Page, setPage] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    import('./modules/admin/AdminPage.js')
      .then((m) => setPage(() => m.default))
      .catch((e) => setErr(t('Chargement impossible : {reason}', { reason: e.message })));
  }, []);
  if (err) return html`<div class="login"><div class="error">${err}</div></div>`;
  return html`${Page ? html`<${Page} onLang=${pickLangLoggedOut} />` : html`<div class="loading">${t('Chargement…')}</div>`}<${Toasts} />`;
}

// ---------------------------------------------------------------------------
// Boot: initial language (browser choice, else the table's, else the browser's), dictionaries, first render.
// ---------------------------------------------------------------------------
async function initialLang() {
  const chosen = storedLang();
  if (chosen) return chosen;
  if (TABLE && bootLobby) {
    const r = await Promise.race([bootLobby, new Promise((res) => setTimeout(() => res(null), 3000))]);
    const l = r?.data?.table?.lang;
    return isLang(l) ? l : 'fr';
  }
  return browserLang();
}

const route = /^\/admin\/?$/.test(location.pathname) ? AdminRoot : TABLE ? App : TablePicker;
const [first] = await Promise.all([initialLang(), loadDictionaries()]);
setLang(first); // the socket is not open yet: a logged-in user's own language arrives with the first state
try {
  document.documentElement.lang = getLang();
} catch {}
render(html`<${route} />`, document.getElementById('app'));
