// Initiative tracker (right dock, GM + players). Server logic: server/modules/30-combat.js.
import { useState } from 'preact/hooks';
import { html, Button, IconButton, Badge, Select, loadCss, confirmAction, promptText } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { useUI, setUI, openSheet, toast } from '../../lib/ui-store.js';
import { INIT_MODES, INIT_MODE_LABEL, DISPO_LABELS, initials, avatarStyle, safeDerive, MonitorBar, rollTooltip, parseDamageInput } from './combat-common.js';

loadCss('/modules/combat/combat.css');

/** Fire an action; errors are already toasted by send(). */
const act = (type, payload = {}) => send(type, payload).catch(() => null);

/** Initiative formula for an actor in a given mode (mirrors the server). */
function initFormula(actor, mode) {
  const d = safeDerive(actor);
  if (!d) return null;
  if (mode === 'astral') return d.astralInitiative;
  if (mode === 'cold') return d.matrixInitiative.cold;
  if (mode === 'hot') return d.matrixInitiative.hot;
  return d.initiative;
}

function stop(ev) {
  ev.stopPropagation();
}

// ---------------------------------------------------------------------------
// No combat running
// ---------------------------------------------------------------------------
function Idle({ game, isGM, selected }) {
  if (!isGM) {
    return html`<div class="cbt">
      <div class="cbt-start">
        <h3>Initiative</h3>
        <div class="muted">Aucun combat en cours. Profite du calme, chummer.</div>
        <div class="cbt-legend">Quand le MJ lance un combat, ton initiative et ton tour s’afficheront ici.</div>
      </div>
    </div>`;
  }
  const mapId = game.scene?.activeMapId;
  const map = mapId ? game.maps?.[mapId] : null;
  const tokens = (map?.tokens || []).filter((t) => t.actorId && game.actors[t.actorId]);
  const visible = tokens.filter((t) => !t.hidden);
  const hiddenCount = tokens.length - visible.length;
  const startWithSelection = async () => {
    const res = await act('combat/start', { includeMapTokens: false });
    if (res) await act('combat/add', { tokenIds: selected });
  };
  return html`<div class="cbt">
    <div class="cbt-start">
      <h3>Nouveau combat</h3>
      <div class="small muted">
        ${map
          ? html`Carte active : <strong class="cyan">${map.name}</strong> — ${visible.length} token${visible.length > 1 ? 's' : ''} avec fiche${hiddenCount ? html`, <span class="faint">${hiddenCount} caché${hiddenCount > 1 ? 's' : ''} (ajoute-les plus tard)</span>` : ''}.`
          : 'Aucune carte active : le combat démarrera vide.'}
      </div>
      <${Button} variant="primary" class="cbt-next" disabled=${!visible.length} onClick=${() => act('combat/start', {})}>⚔ Lancer le combat (${visible.length})</${Button}>
      <div class="cbt-tools">
        ${selected.length > 0 && html`<${Button} small onClick=${startWithSelection}>Avec la sélection (${selected.length})</${Button}>`}
        <${Button} small variant="ghost" onClick=${() => act('combat/start', { includeMapTokens: false })}>Combat vide</${Button}>
      </div>
      <div class="cbt-legend">Les PNJ lancent leur initiative automatiquement ; les runners lancent la leur.</div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Banners (players and GM for their own characters)
// ---------------------------------------------------------------------------
function YourTurn({ e }) {
  return html`<div class="cbt-banner cbt-yourturn">
    <div class="cbt-banner-title">C’est ton tour !</div>
    <div class="small">${e.name} · initiative <strong class="mono">${e.score}</strong></div>
    <div class="row wrap">
      <${Button} variant="accent" onClick=${() => act('combat/next', { entryId: e.id })}>Terminer mon tour ✓</${Button}>
      <${Button} small variant="ghost" title="Retarder ton action : tu pourras agir plus tard dans la passe" onClick=${() => act('combat/delay', { entryId: e.id })}>Retarder</${Button}>
    </div>
  </div>`;
}

function RollBanner({ e, actor }) {
  const mode = e.mode || 'physical';
  const f = initFormula(actor, mode);
  const edge = actor?.edge?.current ?? 0;
  return html`<div class="cbt-banner cbt-toroll">
    <div class="cbt-banner-title">Lance ton initiative</div>
    <div class="small">${e.name}${f ? html` · <span class="mono">${f.base} + ${f.dice}D6</span>` : ''}</div>
    <div class="row wrap">
      <${Button} variant="primary" onClick=${() => act('combat/roll', { entryId: e.id })}>🎲 Lancer${f ? ` (${f.base} + ${f.dice}D6)` : ''}</${Button}>
      <${Button} small disabled=${edge < 1} title="Blitz : dépense 1 point de Chance pour lancer 5D6 ce tour" onClick=${() => act('combat/roll', { entryId: e.id, blitz: true })}>Blitz (1 Chance)</${Button}>
      <${Select} class="grow" value=${mode} options=${INIT_MODES} title="Type d’initiative" onChange=${(m) => act('combat/setMode', { entryId: e.id, mode: m })} />
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// One participant
// ---------------------------------------------------------------------------
function EntryRow({ e, game, c, isGM, own, open, onToggle }) {
  const [editing, setEditing] = useState(false);
  const actor = game.actors?.[e.actorId];
  const showMonitor = isGM || own;
  const d = showMonitor ? safeDerive(actor) : null;
  const isCurrent = c.currentId === e.id;
  const spent = !e.toRoll && e.score <= 0;
  const canControl = isGM || own;
  const edge = actor?.edge?.current ?? 0;
  const cls = ['cbt-entry', 'd-' + (e.disposition || 'hostile'), isCurrent && 'current', e.acted && 'acted', spent && 'spent', e.out && 'out', e.down && 'down', e.hidden && 'hiddenE', own && 'mineE']
    .filter(Boolean)
    .join(' ');

  const focus = () => {
    // On phones the dock covers the map: close it so the focused token is visible.
    if (e.tokenId) setUI({ focusTokenId: e.tokenId, mainTab: 'map', ...(window.innerWidth <= 900 ? { dockOpen: false } : {}) });
    else if (isGM && actor) openSheet(e.actorId);
  };
  const commitScore = (v) => {
    setEditing(false);
    const n = Number(v);
    if (String(v).trim() === '' || !Number.isFinite(n) || n === e.score) return;
    act('combat/setScore', { entryId: e.id, score: Math.round(n) });
  };
  const damage = async () => {
    const txt = await promptText(`Dommages pour ${e.name} (ex. 5P, 3S ; négatif pour soigner : -2P)`, '');
    if (txt === null || txt === undefined || !String(txt).trim()) return;
    const p = parseDamageInput(txt);
    if (!p) return toast('Format attendu : 5P, 3S ou -2P', 'warn');
    if (p.amount > 0) act('actor/damage', { actorId: e.actorId, amount: p.amount, type: p.type });
    else act('actor/heal', { actorId: e.actorId, amount: -p.amount, type: p.type });
  };
  const remove = async () => {
    if (await confirmAction(`Retirer ${e.name} du combat ?`)) act('combat/remove', { entryId: e.id });
  };

  let score;
  if (editing && isGM) {
    score = html`<input class="input cbt-score-input" type="number" value=${e.toRoll ? '' : e.score} autofocus
      onClick=${stop}
      onBlur=${(ev) => commitScore(ev.target.value)}
      onKeyDown=${(ev) => {
        if (ev.key === 'Enter') ev.target.blur();
        if (ev.key === 'Escape') setEditing(false);
      }} />`;
  } else {
    const scls = 'cbt-score' + (isGM ? ' editable' : '') + (e.toRoll ? ' toroll' : '') + (spent ? ' low' : '');
    score = html`<button class=${scls} title=${rollTooltip(e, c.pass) + (isGM ? '\n(clic : modifier le score)' : '')}
      onClick=${(ev) => {
        stop(ev);
        if (isGM) setEditing(true);
      }}>${e.toRoll ? '…' : e.score}</button>`;
  }

  return html`<div class=${cls} onClick=${focus} title=${e.tokenId ? 'Centrer la carte sur ce token' : ''}>
    <div class="cbt-main">
      <div class="cbt-avatar" style=${avatarStyle(actor?.portrait, actor?.color)}>${actor?.portrait ? '' : initials(e.name)}</div>
      <div class="cbt-name">
        <strong>${e.name}</strong>
        <div class="cbt-tags">
          ${isCurrent && html`<${Badge} color="cyan">Agit</${Badge}>`}
          ${e.toRoll && html`<${Badge} color="amber">À lancer</${Badge}>`}
          ${e.delayed && html`<${Badge} color="amber" title="Action retardée">En attente</${Badge}>`}
          ${e.acted && !isCurrent && html`<${Badge}>A agi</${Badge}>`}
          ${e.seized && html`<${Badge} color="magenta" title="A saisi l’initiative ce tour">Saisie</${Badge}>`}
          ${spent && !e.out && html`<${Badge} title="Score ≤ 0 : plus d’action ce tour">Hors passe</${Badge}>`}
          ${e.down && html`<${Badge} color="red">K.O.</${Badge}>`}
          ${e.out && html`<${Badge}>Sorti</${Badge}>`}
          ${e.hidden && html`<${Badge} title="Invisible pour les joueurs">Caché</${Badge}>`}
          ${e.mode && e.mode !== 'physical' && html`<${Badge} color="cyan">${INIT_MODE_LABEL[e.mode]}</${Badge}>`}
          ${isGM && e.disposition && e.disposition !== 'pc' && e.disposition !== 'hostile' && html`<${Badge} color=${e.disposition === 'ally' ? 'green' : 'amber'}>${DISPO_LABELS[e.disposition]}</${Badge}>`}
        </div>
      </div>
      ${score}
      ${canControl && html`<${IconButton} class="cbt-more" icon=${open ? '▴' : '⋯'} title="Actions" onClick=${(ev) => {
        stop(ev);
        onToggle();
      }} />`}
    </div>

    ${e.delayed && canControl && html`<div class="row" onClick=${stop}>
      <${Button} small variant="primary" onClick=${() => act('combat/act', { entryId: e.id })}>Agir maintenant</${Button}>
    </div>`}

    ${d && html`<div class="cbt-mon" onClick=${stop}>
      <${MonitorBar} label="P" kind="p" value=${actor.condition?.physical} max=${d.physicalMonitor} />
      <${MonitorBar} label="É" kind="s" value=${actor.condition?.stun} max=${d.stunMonitor} />
      ${isGM && html`<div class="cbt-dmg">
        <${Button} small title="1 case de dommages physiques" onClick=${() => act('actor/damage', { actorId: e.actorId, amount: 1, type: 'P' })}>+1P</${Button}>
        <${Button} small title="1 case de dommages étourdissants" onClick=${() => act('actor/damage', { actorId: e.actorId, amount: 1, type: 'S' })}>+1É</${Button}>
        <${Button} small title="Dommages ou soins personnalisés" onClick=${damage}>± …</${Button}>
        <${Button} small variant="ghost" title="Ouvrir la fiche" onClick=${() => openSheet(e.actorId)}>Fiche</${Button}>
      </div>`}
    </div>`}

    ${open && canControl && html`<div class="cbt-actions" onClick=${stop}>
      ${e.toRoll && (own || isGM) && html`<${Button} small variant="primary" onClick=${() => act('combat/roll', { entryId: e.id })}>Lancer</${Button}>`}
      ${!e.toRoll && isGM && html`<${Button} small title="Relancer l’initiative" onClick=${() => act('combat/roll', { entryId: e.id })}>Relancer</${Button}>`}
      ${!e.toRoll && html`<${Button} small title="Esquive, parade, blocage, intercepter (−5)" onClick=${() => act('combat/adjust', { entryId: e.id, delta: -5, label: 'Esquive / parade' })}>−5 Esquive</${Button}>
        <${Button} small title="Défense totale (−10)" onClick=${() => act('combat/adjust', { entryId: e.id, delta: -10, label: 'Défense totale' })}>−10 Défense totale</${Button}>`}
      ${!e.seized && html`<${Button} small disabled=${edge < 1} title="Saisir l’initiative : 1 point de Chance, agit en premier ce tour" onClick=${() => act('combat/seize', { entryId: e.id })}>Saisir l’initiative</${Button}>`}
      ${isCurrent && html`<${Button} small onClick=${() => act('combat/delay', { entryId: e.id })}>Retarder</${Button}>`}
      <${Select} value=${e.mode || 'physical'} options=${INIT_MODES} title="Type d’initiative (prochain jet)" onChange=${(m) => act('combat/setMode', { entryId: e.id, mode: m })} />
      ${isGM && html`
        ${e.hidden && html`<${Button} small variant="accent" onClick=${() => act('combat/reveal', { entryId: e.id })}>Révéler</${Button}>`}
        <${Button} small variant="ghost" onClick=${() => act('combat/setOut', { entryId: e.id, out: !e.out })}>${e.out ? 'Réintégrer' : 'Hors combat'}</${Button}>
        <${Button} small variant="danger" onClick=${remove}>Retirer</${Button}>`}
    </div>`}
  </div>`;
}

// ---------------------------------------------------------------------------
// Dock
// ---------------------------------------------------------------------------
export default function CombatDock({ game }) {
  const ui = useUI();
  const [openId, setOpenId] = useState(null);
  const isGM = game.me.role === 'gm';
  const c = game.combat || { active: false, entries: [] };
  const selectedAll = ui.selectedTokenIds || [];
  if (!c.active) return html`<${Idle} game=${game} isGM=${isGM} selected=${selectedAll} />`;

  const mine = new Set(game.me.characterIds || []);
  const entries = c.entries || [];
  const current = entries.find((e) => e.id === c.currentId) || null;
  const myCurrent = current && mine.has(current.actorId) ? current : null;
  const myToRoll = entries.filter((e) => mine.has(e.actorId) && e.toRoll && !e.out);
  const pending = entries.filter((e) => e.toRoll && !e.out && !e.down);
  const npcPending = pending.filter((e) => e.kind !== 'pc');
  const selected = selectedAll.filter((id) => !entries.some((e) => e.tokenId === id));

  const next = async () => {
    if (!current && pending.length) {
      const ok = await confirmAction(`${pending.length} participant(s) n’ont pas lancé leur initiative (${pending.map((e) => e.name).join(', ')}). Commencer quand même ?`);
      if (!ok) return;
    }
    act('combat/next', { entryId: c.currentId || undefined });
  };
  const newTurn = async () => {
    if (await confirmAction('Passer au tour de combat suivant ? Tout le monde relance son initiative.')) act('combat/newTurn');
  };
  const end = async () => {
    if (await confirmAction('Terminer le combat ?')) act('combat/end');
  };

  let waiting = null;
  if (!current) {
    if (pending.length) waiting = `En attente des jets d’initiative : ${pending.map((e) => e.name).join(', ')}.`;
    else if (entries.length) waiting = isGM ? 'Tout le monde a lancé : clique sur « Commencer ».' : 'Le MJ a la main…';
  }

  return html`<div class="cbt">
    <div class="cbt-head">
      <div class="cbt-round"><strong>Tour ${c.round}</strong><span>Passe ${c.pass}</span></div>
      ${isGM && html`<div class="cbt-tools">
        <${IconButton} icon="↶" title="Annuler le dernier passage de tour" onClick=${() => act('combat/prev')} />
        <${IconButton} icon="✕" title="Terminer le combat" onClick=${end} />
      </div>`}
    </div>

    ${isGM && html`<div class="col gap-s">
      <${Button} variant="primary" class="cbt-next" disabled=${!entries.length} onClick=${next}>${current ? 'Tour suivant ▶' : 'Commencer ▶'}</${Button}>
      <div class="cbt-tools">
        ${npcPending.length > 0 && html`<${Button} small onClick=${() => act('combat/rollAll', { npcOnly: true })}>🎲 Lancer les PNJ (${npcPending.length})</${Button}>`}
        ${pending.length > npcPending.length && html`<${Button} small title="Le MJ lance pour les joueurs qui n’ont pas encore lancé" onClick=${() => act('combat/rollAll', {})}>🎲 Tout lancer</${Button}>`}
        <${Button} small onClick=${newTurn} title="Nouveau tour de combat : tout le monde relance">Nouveau tour</${Button}>
        ${selected.length > 0 && html`<${Button} small variant="accent" onClick=${() => act('combat/add', { tokenIds: selected })}>+ Sélection (${selected.length})</${Button}>`}
      </div>
    </div>`}

    ${myCurrent && html`<${YourTurn} e=${myCurrent} />`}
    ${myToRoll.map((e) => html`<${RollBanner} key=${'roll-' + e.id} e=${e} actor=${game.actors?.[e.actorId]} />`)}
    ${waiting && html`<div class="cbt-wait">${waiting}</div>`}

    <div class="cbt-list">
      ${entries.map(
        (e) => html`<${EntryRow} key=${e.id} e=${e} game=${game} c=${c} isGM=${isGM} own=${mine.has(e.actorId)}
          open=${openId === e.id} onToggle=${() => setOpenId(openId === e.id ? null : e.id)} />`
      )}
    </div>
    ${!entries.length &&
    html`<div class="cbt-empty">${isGM ? 'Aucun participant : sélectionne des tokens sur la carte puis « + Sélection », ou fais apparaître des PNJ depuis le bestiaire.' : 'Aucun participant visible pour l’instant.'}</div>`}
    <div class="cbt-legend">Clic sur un participant : centrer la carte · survol du score : détail du jet</div>
  </div>`;
}
