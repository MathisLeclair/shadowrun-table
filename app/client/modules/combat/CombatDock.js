// Initiative tracker (right dock, GM + players). Server logic: server/modules/30-combat.js.
import { useState } from 'preact/hooks';
import { html, Button, IconButton, Badge, Select, loadCss, confirmAction, promptText } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { useUI, setUI, openSheet, toast } from '../../lib/ui-store.js';
import { t, tn, tk } from '../../lib/i18n.js';
import { initModeOptions, initModeLabel, dispoLabel, initials, avatarStyle, safeDerive, MonitorBar, rollTooltip, parseDamageInput } from './combat-common.js';

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
        <h3>${t('Initiative')}</h3>
        <div class="muted">${t('Aucun combat en cours. Profite du calme, chummer.')}</div>
        <div class="cbt-legend">${t('Quand le MJ lance un combat, ton initiative et ton tour s’afficheront ici.')}</div>
      </div>
    </div>`;
  }
  const mapId = game.scene?.activeMapId;
  const map = mapId ? game.maps?.[mapId] : null;
  const tokens = (map?.tokens || []).filter((tok) => tok.actorId && game.actors[tok.actorId]);
  const visible = tokens.filter((tok) => !tok.hidden);
  const hiddenCount = tokens.length - visible.length;
  const startWithSelection = async () => {
    const res = await act('combat/start', { includeMapTokens: false });
    if (res) await act('combat/add', { tokenIds: selected });
  };
  return html`<div class="cbt">
    <div class="cbt-start">
      <h3>${t('Nouveau combat')}</h3>
      <div class="small muted">
        ${map
          ? html`${t('Carte active :')} <strong class="cyan">${map.name}</strong> — ${tn(visible.length, '{n} token avec fiche', '{n} tokens avec fiche')}${hiddenCount ? html`, <span class="faint">${tn(hiddenCount, '{n} caché (ajoute-les plus tard)', '{n} cachés (ajoute-les plus tard)')}</span>` : ''}.`
          : t('Aucune carte active : le combat démarrera vide.')}
      </div>
      <${Button} variant="primary" class="cbt-next" disabled=${!visible.length} onClick=${() => act('combat/start', {})}>⚔ ${t('Lancer le combat ({n})', { n: visible.length })}</${Button}>
      <div class="cbt-tools">
        ${selected.length > 0 && html`<${Button} small onClick=${startWithSelection}>${t('Avec la sélection ({n})', { n: selected.length })}</${Button}>`}
        <${Button} small variant="ghost" onClick=${() => act('combat/start', { includeMapTokens: false })}>${t('Combat vide')}</${Button}>
      </div>
      <div class="cbt-legend">${t('Les PNJ lancent leur initiative automatiquement ; les runners lancent la leur.')}</div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Banners (players and GM for their own characters)
// ---------------------------------------------------------------------------
/** Matrix entries (IC of a host, a decker's agent) have no sheet: kept in sync by the matrix module. */
const isMatrixEntry = (e) => e?.kind === 'ic' || e?.kind === 'agent';
/** Display name: Matrix entries carry a translatable name. */
const entryName = (e) => (e?.nameI18n?.t ? t(e.nameI18n.t, e.nameI18n.params) : e?.name || '');

function YourTurn({ e }) {
  return html`<div class="cbt-banner cbt-yourturn">
    <div class="cbt-banner-title">${t('C’est ton tour !')}</div>
    <div class="small">${entryName(e)} · ${t('initiative')} <strong class="mono">${e.score}</strong></div>
    ${e.kind === 'agent' && html`<div class="small muted">${t('Ton agent agit : choisis son action dans le cockpit (« Laisser mon agent agir »).')}</div>`}
    <div class="row wrap">
      <${Button} variant="accent" onClick=${() => act('combat/next', { entryId: e.id })}>${t('Terminer mon tour')} ✓</${Button}>
      <${Button} small variant="ghost" title=${t('Retarder ton action : tu pourras agir plus tard dans la passe')} onClick=${() => act('combat/delay', { entryId: e.id })}>${t('Retarder')}</${Button}>
    </div>
  </div>`;
}

function RollBanner({ e, actor }) {
  const mode = e.mode || 'physical';
  const f = initFormula(actor, mode);
  const edge = actor?.edge?.current ?? 0;
  return html`<div class="cbt-banner cbt-toroll">
    <div class="cbt-banner-title">${t('Lance ton initiative')}</div>
    <div class="small">${e.name}${f ? html` · <span class="mono">${f.base} + ${f.dice}D6</span>` : ''}</div>
    <div class="row wrap">
      <${Button} variant="primary" onClick=${() => act('combat/roll', { entryId: e.id })}>🎲 ${t('Lancer')}${f ? ` (${f.base} + ${f.dice}D6)` : ''}</${Button}>
      <${Button} small disabled=${edge < 1} title=${t('Blitz : dépense 1 point de Chance pour lancer 5D6 ce tour')} onClick=${() => act('combat/roll', { entryId: e.id, blitz: true })}>${t('Blitz (1 Chance)')}</${Button}>
      <${Select} class="grow" value=${mode} options=${initModeOptions()} title=${t('Type d’initiative')} onChange=${(m) => act('combat/setMode', { entryId: e.id, mode: m })} />
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// One participant
// ---------------------------------------------------------------------------
function EntryRow({ e, game, c, isGM, own, open, onToggle }) {
  const [editing, setEditing] = useState(false);
  const actor = game.actors?.[e.actorId];
  const matrixE = isMatrixEntry(e);
  const name = entryName(e);
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
    else if (matrixE) setUI({ mainTab: 'matrix' });
    else if (isGM && actor) openSheet(e.actorId);
  };
  const icAct = () => act('matrix/icTurn', { hostId: e.hostId, icId: e.icId, entryId: e.id });
  const commitScore = (v) => {
    setEditing(false);
    const n = Number(v);
    if (String(v).trim() === '' || !Number.isFinite(n) || n === e.score) return;
    act('combat/setScore', { entryId: e.id, score: Math.round(n) });
  };
  const damage = async () => {
    const txt = await promptText(t('Dommages pour {name} (ex. 5P, 3S ; négatif pour soigner : -2P)', { name: e.name }), '');
    if (txt === null || txt === undefined || !String(txt).trim()) return;
    const p = parseDamageInput(txt);
    if (!p) return toast(t('Format attendu : 5P, 3S ou -2P'), 'warn');
    if (p.amount > 0) act('actor/damage', { actorId: e.actorId, amount: p.amount, type: p.type });
    else act('actor/heal', { actorId: e.actorId, amount: -p.amount, type: p.type });
  };
  const remove = async () => {
    if (await confirmAction(t('Retirer {name} du combat ?', { name }))) act('combat/remove', { entryId: e.id });
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
    score = html`<button class=${scls} title=${rollTooltip(e, c.pass) + (isGM ? '\n' + t('(clic : modifier le score)') : '')}
      onClick=${(ev) => {
        stop(ev);
        if (isGM) setEditing(true);
      }}>${e.toRoll ? '…' : e.score}</button>`;
  }

  return html`<div class=${cls + (matrixE ? ' cbt-matrix' : '')} onClick=${focus} title=${e.tokenId ? t('Centrer la carte sur ce token') : matrixE ? t('Ouvrir la Matrice') : ''}>
    <div class="cbt-main">
      <div class="cbt-avatar" style=${matrixE ? '' : avatarStyle(actor?.portrait, actor?.color)}>${matrixE ? (e.kind === 'ic' ? '⛨' : '◈') : actor?.portrait ? '' : initials(e.name)}</div>
      <div class="cbt-name">
        <strong>${name}</strong>
        <div class="cbt-tags">
          ${e.kind === 'ic' && html`<${Badge} color="magenta" title=${t('IC d’un hôte (initiative : indice × 2 + 4D6)')}>${t('IC')}</${Badge}>`}
          ${e.kind === 'agent' && html`<${Badge} color="cyan" title=${t('Agent du decker (initiative : Traitement + indice + 4D6)')}>${t('Agent')}</${Badge}>`}
          ${isCurrent && html`<${Badge} color="cyan">${t('Agit')}</${Badge}>`}
          ${e.toRoll && html`<${Badge} color="amber">${t('À lancer')}</${Badge}>`}
          ${e.delayed && html`<${Badge} color="amber" title=${t('Action retardée')}>${t('combat::En attente')}</${Badge}>`}
          ${e.acted && !isCurrent && html`<${Badge}>${t('A agi')}</${Badge}>`}
          ${e.seized && html`<${Badge} color="magenta" title=${t('A saisi l’initiative ce tour')}>${t('Saisie')}</${Badge}>`}
          ${spent && !e.out && html`<${Badge} title=${t('Score ≤ 0 : plus d’action ce tour')}>${t('Hors passe')}</${Badge}>`}
          ${e.down && html`<${Badge} color="red">${t('K.O.')}</${Badge}>`}
          ${e.out && html`<${Badge}>${t('Sorti')}</${Badge}>`}
          ${e.hidden && html`<${Badge} title=${t('Invisible pour les joueurs')}>${t('Caché')}</${Badge}>`}
          ${e.mode && e.mode !== 'physical' && html`<${Badge} color="cyan">${initModeLabel(e.mode)}</${Badge}>`}
          ${isGM && e.disposition && e.disposition !== 'pc' && e.disposition !== 'hostile' && html`<${Badge} color=${e.disposition === 'ally' ? 'green' : 'amber'}>${dispoLabel(e.disposition)}</${Badge}>`}
        </div>
      </div>
      ${score}
      ${canControl && html`<${IconButton} class="cbt-more" icon=${open ? '▴' : '⋯'} title=${t('Actions')} onClick=${(ev) => {
        stop(ev);
        onToggle();
      }} />`}
    </div>

    ${isGM && isCurrent && e.kind === 'ic' && !e.out && html`<div class="row" onClick=${stop}>
      <${Button} small variant="danger" title=${t('L’IC attaque l’intrus le mieux repéré, puis le tour passe')} onClick=${icAct}>⚡ ${t('Agir et passer')}</${Button}>
    </div>`}
    ${e.delayed && canControl && html`<div class="row" onClick=${stop}>
      <${Button} small variant="primary" onClick=${() => act('combat/act', { entryId: e.id })}>${t('Agir maintenant')}</${Button}>
    </div>`}

    ${d && html`<div class="cbt-mon" onClick=${stop}>
      <${MonitorBar} label=${t('moniteur::P')} kind="p" value=${actor.condition?.physical} max=${d.physicalMonitor} />
      <${MonitorBar} label=${t('moniteur::É')} kind="s" value=${actor.condition?.stun} max=${d.stunMonitor} />
      ${isGM && html`<div class="cbt-dmg">
        <${Button} small title=${t('1 case de dommages physiques')} onClick=${() => act('actor/damage', { actorId: e.actorId, amount: 1, type: 'P' })}>${t('+1P')}</${Button}>
        <${Button} small title=${t('1 case de dommages étourdissants')} onClick=${() => act('actor/damage', { actorId: e.actorId, amount: 1, type: 'S' })}>${t('+1É')}</${Button}>
        <${Button} small title=${t('Dommages ou soins personnalisés')} onClick=${damage}>± …</${Button}>
        <${Button} small variant="ghost" title=${t('Ouvrir la fiche')} onClick=${() => openSheet(e.actorId)}>${t('Fiche')}</${Button}>
      </div>`}
    </div>`}

    ${open && canControl && html`<div class="cbt-actions" onClick=${stop}>
      ${e.toRoll && (own || isGM) && html`<${Button} small variant="primary" onClick=${() => act('combat/roll', { entryId: e.id })}>${t('Lancer')}</${Button}>`}
      ${!e.toRoll && isGM && html`<${Button} small title=${t('Relancer l’initiative')} onClick=${() => act('combat/roll', { entryId: e.id })}>${t('Relancer')}</${Button}>`}
      ${!e.toRoll && !matrixE && html`<${Button} small title=${t('Esquive, parade, blocage, intercepter (−5)')} onClick=${() => act('combat/adjust', { entryId: e.id, delta: -5, label: tk('Esquive / parade') })}>${t('−5 Esquive')}</${Button}>
        <${Button} small title=${t('Défense totale (−10)')} onClick=${() => act('combat/adjust', { entryId: e.id, delta: -10, label: tk('Défense totale') })}>${t('−10 Défense totale')}</${Button}>`}
      ${!e.seized && !matrixE && html`<${Button} small disabled=${edge < 1} title=${t('Saisir l’initiative : 1 point de Chance, agit en premier ce tour')} onClick=${() => act('combat/seize', { entryId: e.id })}>${t('Saisir l’initiative')}</${Button}>`}
      ${isCurrent && html`<${Button} small onClick=${() => act('combat/delay', { entryId: e.id })}>${t('Retarder')}</${Button}>`}
      ${!matrixE && html`<${Select} value=${e.mode || 'physical'} options=${initModeOptions()} title=${t('Type d’initiative (prochain jet)')} onChange=${(m) => act('combat/setMode', { entryId: e.id, mode: m })} />`}
      ${isGM && html`
        ${e.hidden && html`<${Button} small variant="accent" onClick=${() => act('combat/reveal', { entryId: e.id })}>${t('Révéler')}</${Button}>`}
        <${Button} small variant="ghost" onClick=${() => act('combat/setOut', { entryId: e.id, out: !e.out })}>${e.out ? t('Réintégrer') : t('Hors combat')}</${Button}>
        <${Button} small variant="danger" onClick=${remove}>${t('Retirer')}</${Button}>`}
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
  const myCurrent = current && (mine.has(current.actorId) || mine.has(current.ownerId)) ? current : null;
  const myToRoll = entries.filter((e) => mine.has(e.actorId) && e.toRoll && !e.out);
  const pending = entries.filter((e) => e.toRoll && !e.out && !e.down);
  const npcPending = pending.filter((e) => e.kind !== 'pc');
  const selected = selectedAll.filter((id) => !entries.some((e) => e.tokenId === id));

  const next = async () => {
    if (!current && pending.length) {
      const ok = await confirmAction(t('{n} participant(s) n’ont pas lancé leur initiative ({names}). Commencer quand même ?', { n: pending.length, names: pending.map((e) => e.name).join(', ') }));
      if (!ok) return;
    }
    act('combat/next', { entryId: c.currentId || undefined });
  };
  const newTurn = async () => {
    if (await confirmAction(t('Passer au tour de combat suivant ? Tout le monde relance son initiative.'))) act('combat/newTurn');
  };
  const end = async () => {
    if (await confirmAction(t('Terminer le combat ?'))) act('combat/end');
  };

  let waiting = null;
  if (!current) {
    if (pending.length) waiting = t('En attente des jets d’initiative : {names}.', { names: pending.map((e) => e.name).join(', ') });
    else if (entries.length) waiting = isGM ? t('Tout le monde a lancé : clique sur « Commencer ».') : t('Le MJ a la main…');
  }

  return html`<div class="cbt">
    <div class="cbt-head">
      <div class="cbt-round"><strong>${t('Tour {n}', { n: c.round })}</strong><span>${t('Passe {n}', { n: c.pass })}</span></div>
      ${isGM && html`<div class="cbt-tools">
        <${IconButton} icon="↶" title=${t('Annuler le dernier passage de tour')} onClick=${() => act('combat/prev')} />
        <${IconButton} icon="✕" title=${t('Terminer le combat')} onClick=${end} />
      </div>`}
    </div>

    ${isGM && html`<div class="col gap-s">
      <${Button} variant="primary" class="cbt-next" disabled=${!entries.length} onClick=${next}>${current ? t('Tour suivant') : t('Commencer')} ▶</${Button}>
      <div class="cbt-tools">
        ${npcPending.length > 0 && html`<${Button} small onClick=${() => act('combat/rollAll', { npcOnly: true })}>🎲 ${t('Lancer les PNJ ({n})', { n: npcPending.length })}</${Button}>`}
        ${pending.length > npcPending.length && html`<${Button} small title=${t('Le MJ lance pour les joueurs qui n’ont pas encore lancé')} onClick=${() => act('combat/rollAll', {})}>🎲 ${t('Tout lancer')}</${Button}>`}
        <${Button} small onClick=${newTurn} title=${t('Nouveau tour de combat : tout le monde relance')}>${t('Nouveau tour')}</${Button}>
        ${selected.length > 0 && html`<${Button} small variant="accent" onClick=${() => act('combat/add', { tokenIds: selected })}>${t('+ Sélection ({n})', { n: selected.length })}</${Button}>`}
      </div>
    </div>`}

    ${myCurrent && html`<${YourTurn} e=${myCurrent} />`}
    ${myToRoll.map((e) => html`<${RollBanner} key=${'roll-' + e.id} e=${e} actor=${game.actors?.[e.actorId]} />`)}
    ${waiting && html`<div class="cbt-wait">${waiting}</div>`}

    <div class="cbt-list">
      ${entries.map(
        (e) => html`<${EntryRow} key=${e.id} e=${e} game=${game} c=${c} isGM=${isGM} own=${mine.has(e.actorId) || mine.has(e.ownerId)}
          open=${openId === e.id} onToggle=${() => setOpenId(openId === e.id ? null : e.id)} />`
      )}
    </div>
    ${!entries.length &&
    html`<div class="cbt-empty">${isGM ? t('Aucun participant : sélectionne des tokens sur la carte puis « + Sélection », ou fais apparaître des PNJ depuis le bestiaire.') : t('Aucun participant visible pour l’instant.')}</div>`}
    <div class="cbt-legend">${t('Clic sur un participant : centrer la carte · survol du score : détail du jet')}</div>
  </div>`;
}
