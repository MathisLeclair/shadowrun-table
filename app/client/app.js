// App shell: login screen, header + main tabs, right dock, sheet modal, toasts, global components.
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { html, Button, Badge, Modal, Tabs } from './lib/ui.js';
import { connect, getToken, setToken, useGame, useConnected, logout, api } from './lib/net.js';
import { useUI, setUI, toast } from './lib/ui-store.js';
import { mainTabs, dockTabs, SheetView, globalComponents } from './modules/registry.js';

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

function Login({ onDone }) {
  const [lobby, setLobby] = useState(null);
  const [mode, setMode] = useState('player');
  const [name, setName] = useState(lsGet('sr.lastName') || '');
  const [pin, setPin] = useState('');
  const [characterId, setCharacterId] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    fetch('/api/lobby').then((r) => r.json()).then(setLobby).catch(() => setErr('Serveur injoignable'));
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    try {
      const body = mode === 'gm' ? { role: 'gm', password } : { role: 'player', name, pin, characterId };
      const res = await api('/api/login', { method: 'POST', body });
      if (mode === 'player') lsSet('sr.lastName', name);
      if (!setToken(res.token)) toast('Stockage du navigateur bloqué : la session ne survivra pas à un rechargement', 'warn');
      onDone();
    } catch (e2) {
      setErr(e2.message);
    }
  };

  return html`<div class="login">
    <form class="login-card" onSubmit=${submit}>
      <div class="login-logo">
        <div class="logo-mark"></div>
        <div><h1>${lobby?.campaignName || 'Shadowrun'}</h1><div class="muted">Shadowrun 5E — Seattle, 2080</div></div>
      </div>
      <${Tabs} tabs=${[{ id: 'player', label: 'Joueur' }, { id: 'gm', label: 'Maître de jeu' }]} value=${mode} onChange=${setMode} />
      ${mode === 'gm'
        ? html`<label class="field"><span class="field-label">Mot de passe MJ</span>
            <input class="input" type="password" value=${password} onInput=${(e) => setPassword(e.target.value)} autofocus /></label>`
        : html`
          <label class="field"><span class="field-label">Ton nom</span>
            <input class="input" value=${name} onInput=${(e) => setName(e.target.value)} placeholder="ex. Baptiste" autofocus /></label>
          <label class="field"><span class="field-label">Code PIN (optionnel, protège ton accès)</span>
            <input class="input" type="password" inputmode="numeric" value=${pin} onInput=${(e) => setPin(e.target.value)} /></label>
          <div class="field"><span class="field-label">Ton personnage</span>
            <div class="pc-pick">
              ${(lobby?.pcs || []).map(
                (pc) => html`<button type="button" class=${'pc-choice' + (characterId === pc.id ? ' active' : '')}
                    disabled=${pc.claimedBy && pc.claimedBy.toLowerCase() !== name.trim().toLowerCase()}
                    onClick=${() => setCharacterId(characterId === pc.id ? '' : pc.id)}>
                  <strong>${pc.name}</strong>
                  <span class="muted">${pc.claimedBy ? `joué par ${pc.claimedBy}` : pc.player || 'libre'}</span>
                </button>`
              )}
              ${lobby && !lobby.pcs.length && html`<div class="muted">Aucun personnage pour l'instant — le MJ pourra t'en attribuer un.</div>`}
            </div>
          </div>`}
      ${err && html`<div class="error">${err}</div>`}
      <${Button} variant="primary" type="submit">Entrer dans la partie</${Button}>
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
  if (!game) return html`<div class="loading">Connexion à la Matrice…</div>`;
  const role = game.me.role;
  const tabs = mainTabs.filter((t) => t.roles.includes(role));
  const docks = dockTabs.filter((t) => t.roles.includes(role));
  const current = tabs.find((t) => t.id === ui.mainTab) || tabs[0];
  const dock = docks.find((t) => t.id === ui.dockTab) || docks[0];
  const Main = current.component;
  const Dock = dock?.component;

  return html`<div class=${'shell' + (ui.dockOpen ? '' : ' dock-closed')}>
    <header class="topbar">
      <div class="brand"><div class="logo-mark small"></div><span>${game.config.campaignName}</span></div>
      <nav class="main-tabs">
        ${tabs.map((t) => {
          const badge = t.badge ? t.badge(game) : null;
          return html`<button class=${'main-tab' + (t.id === current.id ? ' active' : '')} onClick=${() => setUI({ mainTab: t.id })}>
            <span class="tab-icon">${t.icon}</span><span class="tab-label">${t.label}</span>${badge ? html`<span class="tab-badge">${badge}</span>` : null}
          </button>`;
        })}
      </nav>
      <div class="topbar-right">
        <span class=${'conn ' + (online ? 'on' : 'off')} title=${online ? 'Connecté' : 'Déconnecté — reconnexion…'}></span>
        <${Badge} color=${role === 'gm' ? 'magenta' : 'cyan'}>${role === 'gm' ? 'MJ' : game.me.name}</${Badge}>
        <button class="icon-btn" title=${ui.dockOpen ? 'Masquer le panneau' : 'Afficher le panneau'} onClick=${() => setUI({ dockOpen: !ui.dockOpen })}>${ui.dockOpen ? '⇥' : '⇤'}</button>
        <button class="icon-btn" title="Se déconnecter" onClick=${logout}>⏻</button>
      </div>
    </header>
    ${game.ui?.announcement && html`<div class="announcement">${game.ui.announcement}</div>`}
    <main class="main"><${Main} game=${game} /></main>
    ${ui.dockOpen &&
    Dock &&
    html`<aside class="dock">
      <${Tabs} class="dock-tabs" tabs=${docks.map((d) => ({ id: d.id, label: d.label, badge: d.badge ? d.badge(game) : null }))} value=${dock.id} onChange=${(id) => setUI({ dockTab: id })} />
      <div class="dock-body"><${Dock} game=${game} /></div>
    </aside>`}
    ${ui.sheetActorId &&
    game.actors[ui.sheetActorId] &&
    html`<${Modal} title=${game.actors[ui.sheetActorId].name} width=${1100} onClose=${() => setUI({ sheetActorId: null })}>
      <${SheetView} game=${game} actorId=${ui.sheetActorId} />
    </${Modal}>`}
    ${globalComponents.map((C) => html`<${C} game=${game} />`)}
  </div>`;
}

function Toasts() {
  const ui = useUI();
  return html`<div class="toasts">${ui.toasts.map((t) => html`<div class=${'toast toast-' + t.kind}>${t.text}</div>`)}</div>`;
}

function App() {
  const [authed, setAuthed] = useState(!!getToken());
  useEffect(() => {
    if (!authed) return;
    let done = false;
    const s = connect(() => {
      if (done) return;
      done = true;
      setToken(null);
      setAuthed(false);
      toast('Session expirée, reconnecte-toi', 'warn');
    });
    return () => s.disconnect();
  }, [authed]);
  return html`${authed ? html`<${Shell} />` : html`<${Login} onDone=${() => setAuthed(true)} />`}<${Toasts} />`;
}

render(html`<${App} />`, document.getElementById('app'));
