// Decker cockpit: connection mode, ASDF configuration, programs, agent, Overwatch, marks, current host, actions.
import { useEffect, useState } from 'preact/hooks';
import { html, Button, Badge, Select, TextInput, confirmAction } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { goTab } from '../../lib/ui-store.js';
import { t, getLang } from '../../lib/i18n.js';
import { attr } from '/shared/sr5.js';
import {
  ASDF, ASDF_LABELS, ASDF_SHORT, MODES, MODE_LABELS, ACTIONS, ACTION_CATS, ACTION_TYPES, IC_TYPES, PROGRAM_BY_ID,
  deckStats, actionPool, matrixInitiative, agentInitiative, programSlots, availablePrograms, detectAgents, isIllegal,
  isCyberdeck, matrixMonitor, programId,
} from '/shared/matrix.js';
import {
  isGM, act, personaOf, OsMeter, MatrixMonitor, MatrixLog, marksDots, actionName, icName, markName, linkLockName, programLabel,
  asdfShort, asdfLabel, modeLabel, marksText, assistText, agentLabel,
} from './common.js';
import ActionModal from './ActionModal.js';
import { BookRef, RuleRef } from '../books/BookRef.js';
import { ProgramRef } from './common.js';

const CAT_ORDER = ['attack', 'sleaze', 'info', 'control', 'util'];

/** Keep the combat tracker's initiative type in sync with the connection mode (silently; combat module action). */
function syncCombatMode(game, actorId, mode) {
  const c = game.combat;
  if (!c?.active) return;
  const e = (c.entries || []).find((x) => x.actorId === actorId);
  if (e && e.mode !== mode) send('combat/setMode', { entryId: e.id, mode }, { silent: true }).catch(() => {});
}

function ModeSwitch({ game, actor, persona, onJackOut }) {
  const cur = persona.online ? persona.mode : 'off';
  const choose = async (mode) => {
    if (mode === 'off') {
      if (!persona.online) return;
      if (persona.linkLocked) return onJackOut();
      await act('matrix/disconnect', { actorId: actor.id });
      syncCombatMode(game, actor.id, 'physical');
      return;
    }
    const r = await act('matrix/connect', { actorId: actor.id, mode });
    if (r) syncCombatMode(game, actor.id, mode);
  };
  const opts = [{ id: 'off', label: t('Hors ligne') }, ...MODES.map((m) => ({ id: m, label: modeLabel(m) }))];
  return html`<div class="mx-modes" role="radiogroup" aria-label=${t('Mode de connexion')}>
    ${opts.map((o) => {
      const ini = o.id === 'off' ? null : matrixInitiative(actor, persona, o.id);
      return html`<button type="button" role="radio" aria-checked=${cur === o.id} class=${'mx-mode mx-mode-' + o.id + (cur === o.id ? ' on' : '')}
        disabled=${persona.bricked && o.id !== 'off'} onClick=${() => choose(o.id)} title=${o.id === 'hot' ? t('+2 dés aux actions matricielles, biofeedback physique') : o.id === 'cold' ? t('Biofeedback étourdissant') : o.id === 'ar' ? t('Initiative physique, pas de biofeedback') : ''}>
        <span>${o.label}</span>${ini && html`<small class="mono">${ini.text}</small>`}
      </button>`;
    })}
  </div>`;
}

function AsdfPanel({ actor, persona, canEdit }) {
  const ds = deckStats(actor, persona);
  const deck = ds.isDeck;
  const [sel, setSel] = useState(null);
  const swap = (a, b) => {
    setSel(null);
    if (!a || !b || a === b) return;
    act('matrix/setASDF', { actorId: actor.id, swap: [a, b] });
  };
  const keys = deck ? ASDF : ['dataProcessing', 'firewall'];
  return html`<div class="mx-panel">
    <div class="mx-panel-title">${t('Configuration')} <span class="faint">${deck ? t('glisse une case sur une autre pour permuter') : t('commlink : pas de permutation')}</span></div>
    <div class=${'mx-asdf' + (deck ? '' : ' two')}>
      ${keys.map((k) => {
        const tip = `${t('{attr} : {n}', { attr: asdfLabel(k), n: ds.slotted[k] })}${ds.bonus[k] ? ` ${t('+{n} (programmes)', { n: ds.bonus[k] })}` : ''}${ds.penalty[k] ? ` ${t('−{n} (IC)', { n: ds.penalty[k] })}` : ''}`;
        return html`<button type="button" key=${k} class=${'mx-asdf-cell' + (sel === k ? ' sel' : '') + (ds.bonus[k] ? ' boosted' : '') + (ds.penalty[k] ? ' hurt' : '')}
          draggable=${deck && canEdit} title=${tip} disabled=${!canEdit && deck}
          onDragStart=${(e) => { e.dataTransfer.setData('text/plain', k); e.dataTransfer.effectAllowed = 'move'; }}
          onDragOver=${(e) => deck && e.preventDefault()}
          onDrop=${(e) => { e.preventDefault(); swap(e.dataTransfer.getData('text/plain'), k); }}
          onClick=${() => { if (!deck || !canEdit) return; if (!sel) setSel(k); else swap(sel, k); }}>
          <span class="mx-asdf-k">${asdfShort(k)}</span>
          <b class="mono">${ds.eff[k]}</b>
          <span class="mx-asdf-l">${asdfLabel(k)}</span>
          ${(ds.bonus[k] || ds.penalty[k]) ? html`<span class="mx-asdf-mod">${ds.bonus[k] ? `+${ds.bonus[k]}` : ''}${ds.penalty[k] ? ` −${ds.penalty[k]}` : ''}</span>` : null}
        </button>`;
      })}
    </div>
    ${sel && html`<div class="small cyan">${t('Choisis l’attribut à permuter avec {attr}…', { attr: asdfLabel(sel) })}</div>`}
  </div>`;
}

function ProgramsPanel({ actor, persona, canEdit }) {
  const [open, setOpen] = useState(false);
  const slots = programSlots({ ...persona, programSlots: persona.programSlots || 4 });
  const loaded = persona.loadedPrograms || [];
  const avail = availablePrograms(actor).filter((p) => p.id !== 'agent' && !loaded.some((n) => n.toLowerCase() === p.name.toLowerCase()));
  const chip = (name, loadedChip) => {
    const def = PROGRAM_BY_ID[programId(name)];
    return html`<span class=${'mx-prog' + (loadedChip ? ' on' : '')} key=${name} title=${def ? t(def.effect) : t('Programme inconnu : effet au MJ')}>
      <span>${programLabel(name)}</span><${ProgramRef} name=${name} />
      ${def?.auto && loadedChip ? html`<i class="mx-prog-auto" title=${t('Effet appliqué automatiquement')}>✓</i>` : null}
      ${canEdit && (loadedChip
        ? html`<button type="button" title=${t('Décharger')} onClick=${() => act('matrix/unloadProgram', { actorId: actor.id, name })}>✕</button>`
        : html`<button type="button" title=${t('Charger')} disabled=${slots.free <= 0 && programId(name) !== 'virtualMachine'} onClick=${() => act('matrix/loadProgram', { actorId: actor.id, name })}>+</button>`)}
    </span>`;
  };
  return html`<div class="mx-panel">
    <div class="mx-panel-title">${t('Programmes')} <span class=${'mono ' + (slots.free < 0 ? 'red' : 'cyan')}>${slots.used}/${slots.total}</span> <${RuleRef} rule="programs" /></div>
    <div class="mx-slots">${Array.from({ length: slots.total }, (_, i) => html`<i class=${i < slots.used ? 'on' : ''}></i>`)}</div>
    <div class="mx-progs">
      ${loaded.map((n) => chip(n, true))}
      ${persona.agent?.loaded && html`<span class="mx-prog on agent" title=${t('L’agent occupe un emplacement')}>◈ ${persona.agent.name}</span>`}
      ${!loaded.length && !persona.agent?.loaded && html`<span class="muted small">${t('Aucun programme chargé.')}</span>`}
    </div>
    ${loaded.length > 0 && html`<ul class="mx-prog-effects">${loaded.map((n) => {
      const def = PROGRAM_BY_ID[programId(n)];
      return html`<li key=${n}><b>${programLabel(n)}</b> — ${def ? t(def.effect) : t('effet au MJ')}${def && !def.auto ? html` <span class="faint">${t('(au MJ)')}</span>` : ''}</li>`;
    })}</ul>`}
    ${avail.length > 0 && html`<button type="button" class="mx-link" onClick=${() => setOpen(!open)}>${open ? t('Masquer les programmes disponibles ({n})', { n: avail.length }) : t('Afficher les programmes disponibles ({n})', { n: avail.length })}</button>`}
    ${open && html`<div class="mx-progs avail">${avail.map((p) => chip(p.name, false))}</div>`}
  </div>`;
}

function AgentPanel({ game, actor, persona, canEdit }) {
  const gm = isGM(game);
  const ag = persona.agent;
  const owned = detectAgents(actor);
  const maxOwned = owned.reduce((m, x) => Math.max(m, x.rating), 0);
  const maxRating = gm ? 6 : maxOwned;
  const configure = (patch) => act('matrix/configureAgent', { actorId: actor.id, rating: ag?.rating || maxRating || 1, name: ag?.name || '', ...patch });
  if (!ag) {
    return html`<div class="mx-panel mx-agent">
      <div class="mx-panel-title">${t('Agent')}</div>
      <p class="small muted">${t('Un agent est un programme autonome (indice 1 à 6) : il peut t’assister (travail d’équipe) ou agir seul pendant que tu fais autre chose.')}</p>
      ${maxOwned
        ? html`<${Button} small variant="primary" disabled=${!canEdit} onClick=${() => configure({ rating: maxOwned })}>${t('Configurer mon agent (indice {n})', { n: maxOwned })}</${Button}>`
        : html`<div class="row wrap">
            ${!gm && html`<${Button} small onClick=${() => goTab('shop')}>${t('Acheter un agent (Boutique › Logiciels)')}</${Button}>`}
            ${gm && html`<${Button} small variant="primary" onClick=${() => configure({ rating: 3 })}>${t('Donner un agent (indice {n})', { n: 3 })}</${Button}>`}
          </div>`}
    </div>`;
  }
  const ini = agentInitiative(actor, persona);
  const mon = matrixMonitor(ag.rating);
  const ratingOpts = Array.from({ length: Math.max(1, maxRating || ag.rating) }, (_, i) => ({ value: String(i + 1), label: t('Indice {n}', { n: i + 1 }) }));
  return html`<div class=${'mx-panel mx-agent' + (ag.loaded ? ' live' : '')}>
    <div class="mx-panel-title">${t('Agent')} <span class=${ag.loaded ? 'green' : 'faint'}>${ag.loaded ? t('chargé') : t('en veille')}</span></div>
    <div class="mx-agent-card">
      <span class="mx-agent-avatar">◈</span>
      <div class="grow">
        ${canEdit
          ? html`<${TextInput} value=${ag.name} onChange=${(v) => configure({ name: v })} placeholder=${t('Nom de l’agent')} />`
          : html`<b>${ag.name}</b>`}
        <div class="small muted">${t('Indice {r} · {dice} dés par action · Init. {init}', { r: ag.rating, dice: ag.rating * 2, init: ini.text })}</div>
      </div>
      ${canEdit && html`<${Select} value=${String(ag.rating)} options=${ratingOpts} onChange=${(v) => configure({ rating: Number(v) })} />`}
    </div>
    <${MatrixMonitor} label=${t('Dommages de l’agent')} value=${ag.damage || 0} max=${mon} onSet=${gm ? (n) => act('matrix/setPersona', { actorId: actor.id, patch: { agent: { damage: n } } }) : null} />
    ${persona.pendingAssist && html`<div class="mx-pending">${t('Assistance prête : {bonus} pour la prochaine action « {action} » (même compétence).', { bonus: assistText(persona.pendingAssist), action: actionName(ACTIONS.find((a) => a.id === persona.pendingAssist.actionId)) })}</div>`}
    <div class="row wrap">
      ${canEdit && html`<${Button} small variant=${ag.loaded ? 'ghost' : 'primary'} onClick=${() => act('matrix/agentLoad', { actorId: actor.id, loaded: !ag.loaded })}>${ag.loaded ? t('Décharger') : t('Charger (1 emplacement)')}</${Button}>`}
      ${owned.length > 0 && html`<span class="faint small">${t('Possédé : {list}', { list: owned.map(agentLabel).join(' · ') })}</span>`}
    </div>
    <p class="small faint">${t('Depuis « Lancer » sur une action : « Faire assister mon agent » ou « Laisser mon agent agir ».')}</p>
  </div>`;
}

function StatusPanel({ game, actor, persona }) {
  const gm = isGM(game);
  const ds = deckStats(actor, persona);
  const pen = Object.entries(persona.penalties || {}).filter(([, v]) => v > 0);
  return html`<div class="mx-panel mx-status">
    <${OsMeter} value=${persona.overwatch} hidden=${persona.overwatchHidden} knownAt=${persona.osKnownAt} />
    <${MatrixMonitor} value=${persona.matrixDamage} deviceRating=${ds.deviceRating} onSet=${gm ? (n) => act('matrix/setPersona', { actorId: actor.id, patch: { matrixDamage: n } }) : null} />
    <div class="mx-chips">
      ${persona.bricked && html`<${Badge} color="red">${t('Deck briqué')}</${Badge}>`}
      ${ds.rawNoise > 0 && html`<${Badge} color="amber" title=${t('Bruit (−dés aux actions matricielles)')}>${t('Bruit {n}', { n: ds.rawNoise })}${ds.noise !== ds.rawNoise ? ` → ${ds.noise}` : ''}</${Badge}>`}
      ${persona.linkLocked && html`<${Badge} color="red" title=${t('Impossible de se déconnecter normalement')}>${t('Verrou de lien : {name}', { name: linkLockName(persona.linkLocked) })}</${Badge}>`}
      ${persona.fullDefense && html`<span class="mx-chip-btn"><${Badge} color="cyan">${t('Défense totale (+VOL {n})', { n: attr(actor, 'WIL') })}</${Badge}><button type="button" title=${t('Terminer la défense totale')} onClick=${() => act('matrix/setFullDefense', { actorId: actor.id, on: false })}>✕</button></span>`}
      ${persona.traced && html`<${Badge} color="magenta" title=${t('Position physique connue de l’adversaire')}>${t('Localisé(e)')}</${Badge}>`}
      ${pen.map(([k, v]) => html`<${Badge} color="red" key=${k}>${asdfLabel(k)} −${v}</${Badge}>`)}
    </div>
  </div>`;
}

function MarksPanel({ persona, onErase }) {
  const marks = (persona.marks || []).filter((m) => m.count > 0);
  const onMe = (persona.marksOnMe || []).filter((m) => m.count > 0);
  return html`<div class="mx-panel">
    <div class="mx-panel-title">${t('Marques')}</div>
    ${marks.length === 0 && html`<div class="muted small">${t('Aucune marque posée.')}</div>`}
    ${marks.map((m) => html`<div class="mx-mark" key=${m.targetId}><span class="grow">${markName(m)}</span>${marksDots(m.count)}</div>`)}
    ${onMe.length > 0 && html`<div class="mx-panel-sub">${t('Marques sur moi')}</div>`}
    ${onMe.map((m) => html`<div class="mx-mark hostile" key=${m.sourceId}><span class="grow">${markName(m)}</span>${marksDots(m.count)}
      ${onErase && html`<button type="button" class="mx-link" onClick=${() => onErase(m)}>${t('marque::Effacer')}</button>`}</div>`)}
  </div>`;
}

function HostPanel({ game, actor, persona, open }) {
  const hosts = Object.values(game.matrix?.hosts || {});
  const gm = isGM(game);
  const cur = persona.hostId ? game.matrix?.hosts?.[persona.hostId] : null;
  const marksOn = (h) => (persona.marks || []).find((m) => m.targetId === `host:${h.id}`)?.count || 0;
  if (!cur) {
    const list = hosts.filter((h) => gm || h.visible || marksOn(h));
    return html`<div class="mx-panel mx-host">
      <div class="mx-panel-title">${t('Grille publique')}</div>
      ${list.length === 0 && html`<div class="muted small">${t('Aucun hôte repéré pour l’instant.')}</div>`}
      ${list.map((h) => html`<div class="mx-hostrow" key=${h.id}>
        <div class="grow"><b>${h.name}</b>${h.rating ? html` <span class="faint small">${t('indice {n}', { n: h.rating })}</span>` : ''}
          ${h.alert === 'active' && html` <${Badge} color="red">${t('Alerte')}</${Badge}>`}</div>
        ${marksDots(marksOn(h))}
        <${Button} small disabled=${!persona.online} onClick=${() => open('hackOnTheFly', { targetId: `host:${h.id}` })}>${t('Marquer')}</${Button}>
        <${Button} small variant="primary" disabled=${!persona.online || !marksOn(h)} title=${marksOn(h) ? '' : t('Il faut 1 marque sur l’hôte')} onClick=${() => act('matrix/action', { actorId: actor.id, actionId: 'enterHost', targetId: `host:${h.id}` })}>${t('Entrer')}</${Button}>
      </div>`)}
    </div>`;
  }
  const perceived = gm || cur.perceived;
  const ic = (cur.ic || []).filter((x) => (gm ? x.active : true));
  return html`<div class=${'mx-panel mx-host inside' + (cur.alert === 'active' ? ' alert' : '')}>
    <div class="mx-panel-title">${t('Hôte')} ${cur.alert === 'active' ? html`<${Badge} color="red">${t('ALERTE')}</${Badge}>` : html`<${Badge} color="green">${t('calme')}</${Badge}>`}</div>
    <div class="mx-host-name">${cur.name}</div>
    ${cur.description && html`<div class="small muted">${cur.description}</div>`}
    ${perceived
      ? html`<div class="mx-host-attrs">
          <span>${t('Indice')} <b>${cur.rating}</b></span>${ASDF.map((k) => html`<span key=${k}>${asdfShort(k)} <b>${cur[k]}</b></span>`)}
        </div>`
      : html`<div class="small faint">${t('Indice et contenu inconnus : fais une Perception matricielle.')}</div>`}
    ${cur.spotted && html`<div class="small red">${t('La patrouille t’a repéré(e).')}</div>`}
    <div class="mx-panel-sub">${t('IC actives')} <${RuleRef} rule="ic" /></div>
    ${ic.length === 0 && html`<div class="muted small">${t('Aucune IC active.')}</div>`}
    ${ic.map((x) => html`<div class="mx-icrow" key=${x.id}>
      <span class="grow" title=${IC_TYPES[x.type]?.desc ? t(IC_TYPES[x.type].desc) : ''}>${icName(x.type)}${x.rating ? html` <span class="faint small">${t('indice {n}', { n: x.rating })}</span>` : ''}</span>
      ${x.rating ? html`<span class="mono small">${x.damage || 0}/${matrixMonitor(x.rating)}</span>` : null}
      <${Button} small variant="danger" disabled=${!persona.online} onClick=${() => open('dataSpike', { targetId: `ic:${cur.id}:${x.id}` })}>${t('Pointe')}</${Button}>
    </div>`)}
    ${perceived && html`<div class="mx-panel-sub">${t('Fichiers')}</div>`}
    ${perceived && (cur.files || []).length === 0 && html`<div class="muted small">${t('Aucun fichier.')}</div>`}
    ${perceived && (cur.files || []).map((f) => html`<div class="mx-filerow" key=${f.id}>
      <span class="grow">${f.protected ? '🔒 ' : ''}${f.name}${f.bomb ? html` <${Badge} color="red">${t('bombe {n}', { n: f.bomb })}</${Badge}>` : ''}${f.value != null ? html` <span class="faint small">${f.value}¥</span>` : ''}</span>
      ${f.protected && html`<${Button} small onClick=${() => open('crackFile', { targetId: `file:${cur.id}:${f.id}` })}>${t('Craquer')}</${Button}>`}
      ${f.bomb > 0 && !f.mine && html`<${Button} small onClick=${() => open('disarmDataBomb', { targetId: `file:${cur.id}:${f.id}` })}>${t('Désamorcer')}</${Button}>`}
      <${Button} small variant="primary" disabled=${f.protected} onClick=${() => open('editFile', { targetId: `file:${cur.id}:${f.id}`, fileOp: 'copy' })}>${t('Éditer')}</${Button}>
    </div>`)}
    ${perceived && (cur.devices || []).length > 0 && html`<div class="mx-panel-sub">${t('Appareils esclaves')}</div>`}
    ${perceived && (cur.devices || []).map((d) => html`<div class="mx-filerow" key=${d.id}>
      <span class="grow">${d.name} <span class="faint small">${t('indice {n}', { n: d.rating })}</span>${d.offline ? html` <${Badge}>${t('hors ligne')}</${Badge}>` : ''}${d.bricked ? html` <${Badge} color="red">${t('briqué')}</${Badge}>` : ''}</span>
      <${Button} small variant="primary" onClick=${() => open('controlDevice', { targetId: `device:${cur.id}:${d.id}` })}>${t('Contrôler')}</${Button}>
    </div>`)}
    <div class="row wrap mx-host-foot">
      <${Button} small onClick=${() => open('matrixPerception', { targetId: `host:${cur.id}` })}>${t('Perception')}</${Button}>
      <${Button} small variant="ghost" onClick=${() => act('matrix/action', { actorId: actor.id, actionId: 'exitHost' })}>${t('Sortir de l’hôte')}</${Button}>
    </div>
  </div>`;
}

function PaydataPanel({ persona }) {
  const [openId, setOpenId] = useState(null);
  const files = persona.files || [];
  if (!files.length) return null;
  return html`<div class="mx-panel">
    <div class="mx-panel-title">${t('Données récupérées ({n})', { n: files.length })}</div>
    ${files.map((f) => html`<div class="mx-paydata" key=${f.id}>
      <button type="button" class="mx-paydata-head" onClick=${() => setOpenId(openId === f.id ? null : f.id)}>
        <span class="grow">${f.name}</span><span class="faint small">${f.hostName}${f.readOnly ? ` · ${t('lu')}` : ''}</span>
      </button>
      ${openId === f.id && html`<div class="mx-paydata-body">${f.content || html`<span class="muted">${t('Contenu à décrire par le MJ.')}</span>`}</div>`}
    </div>`)}
  </div>`;
}

function ActionsPanel({ actor, persona, open }) {
  const [filter, setFilter] = useState('all');
  const list = ACTIONS.filter((a) => (filter === 'illegal' ? isIllegal(a) : filter === 'legal' ? !isIllegal(a) : true));
  const filters = [{ id: 'all', label: t('Toutes') }, { id: 'illegal', label: t('Illégales') }, { id: 'legal', label: t('Légales') }];
  return html`<div class="mx-panel mx-actions">
    <div class="mx-panel-title spread">
      <span>${t('Actions matricielles')} <${RuleRef} rule="matrixActions" /></span>
      <span class="mx-seg small">${filters.map((f) => html`<button type="button" class=${filter === f.id ? 'on' : ''} onClick=${() => setFilter(f.id)}>${f.label}</button>`)}</span>
    </div>
    ${CAT_ORDER.map((cat) => {
      const items = list.filter((a) => a.cat === cat);
      if (!items.length) return null;
      const illegal = cat === 'attack' || cat === 'sleaze';
      return html`<div class="mx-actgroup" key=${cat}>
        <div class=${'mx-actgroup-title ' + (illegal ? 'illegal' : 'legal')}>${illegal ? t('Illégal') : t('Légal')} · ${t(ACTION_CATS[cat])}</div>
        ${items.map((a) => {
          const pc = actionPool(actor, persona, a, {});
          return html`<div class="mx-actrow" key=${a.id}>
            <div class="grow mx-act-name" title=${t(a.desc)}>
              <b>${actionName(a)}</b>${getLang() === 'fr' ? html` <span class="faint small">${a.en}</span>` : null}${a.page ? html` <${BookRef} source="SR5" page=${a.page} />` : null}
              <div class="small muted">${ACTION_TYPES[a.type] ? t(ACTION_TYPES[a.type]) : a.type}${a.marks ? ` · ${marksText(a.marks)}` : ''}${a.skill ? ` · ${a.limit ? `[${asdfLabel(a.limit)}]` : ''}` : ''}</div>
            </div>
            <span class="mx-act-pool mono">${a.noTest ? '—' : pc.impossible ? html`<span class="red small">${t('non formé')}</span>` : html`${pc.pool}<small>${pc.limit !== null ? ` [${pc.limit}]` : ''}</small>`}</span>
            <${Button} small variant=${illegal ? 'accent' : 'primary'} disabled=${(!persona.online && a.id !== 'rebootSelf') || pc.impossible} onClick=${() => open(a.id)}>${t('Lancer')}</${Button}>
          </div>`;
        })}
      </div>`;
    })}
  </div>`;
}

export default function Cockpit({ game, actorId }) {
  const actor = game.actors?.[actorId];
  const [modal, setModal] = useState(null); // { actionId, preset }
  const gm = isGM(game);
  const canEdit = !!actor && (gm || (game.me.characterIds || []).includes(actor.id));
  const isVirtual = !!actor?.matrix && !game.matrix?.personas?.[actorId];
  // First visit: let the server create the persona (deck program slots, agent detection).
  useEffect(() => {
    if (isVirtual && canEdit) send('matrix/ensure', { actorId }, { silent: true }).catch(() => {});
  }, [actorId, isVirtual]);
  if (!actor || !actor.matrix) return null;
  const persona = personaOf(game, actor);
  const ds = deckStats(actor, persona);
  const open = (actionId, preset = {}) => setModal({ actionId, preset, k: Date.now() });
  const reboot = async () => {
    const question = persona.online && persona.mode !== 'ar'
      ? t('Redémarrer le deck de {name} ? Le Score d’Overwatch revient à 0 et toutes les marques sont effacées, mais tu subis un choc d’éjection.', { name: actor.name })
      : t('Redémarrer le deck de {name} ? Le Score d’Overwatch revient à 0 et toutes les marques sont effacées, mais tu es déconnecté(e).', { name: actor.name });
    if (await confirmAction(question)) {
      act('matrix/action', { actorId: actor.id, actionId: 'rebootSelf' });
    }
  };
  const action = modal && ACTIONS.find((a) => a.id === modal.actionId);
  return html`<div class=${'mx-cockpit' + (persona.online ? ' online mode-' + persona.mode : ' offline') + ((persona.overwatch || 0) >= 30 ? ' danger' : '')}>
    <header class="mx-deckbar">
      <div class="mx-deck-id">
        <div class="mx-deck-name">${actor.matrix.device || t('Appareil')}</div>
        <div class="small muted">${actor.name} · ${isCyberdeck(actor) ? t('cyberdeck') : t('commlink')} · ${t('indice {n}', { n: ds.deviceRating })}${persona.hostId && game.matrix?.hosts?.[persona.hostId] ? ` · ${t('dans {host}', { host: game.matrix.hosts[persona.hostId].name })}` : ''}</div>
      </div>
      <${ModeSwitch} game=${game} actor=${actor} persona=${persona} onJackOut=${() => open('jackOut')} />
      <div class="mx-deck-btns">
        <${Button} small variant="ghost" disabled=${!canEdit || persona.bricked} onClick=${reboot} title=${t('Remet le Score d’Overwatch à 0')}>${t('Redémarrer le deck')}</${Button}>
      </div>
    </header>
    <div class="mx-grid">
      <div class="mx-col">
        <${AsdfPanel} actor=${actor} persona=${persona} canEdit=${canEdit} />
        <${ProgramsPanel} actor=${actor} persona=${persona} canEdit=${canEdit} />
        <${AgentPanel} game=${game} actor=${actor} persona=${persona} canEdit=${canEdit} />
      </div>
      <div class="mx-col">
        <${StatusPanel} game=${game} actor=${actor} persona=${persona} />
        <${MarksPanel} persona=${persona} onErase=${persona.online ? (m) => open('eraseMark', { targetId: `mark:${m.sourceId}` }) : null} />
        <${PaydataPanel} persona=${persona} />
      </div>
      <div class="mx-col">
        <${HostPanel} game=${game} actor=${actor} persona=${persona} open=${open} />
        <${MatrixLog} game=${game} actorId=${actor.id} limit=${10} />
      </div>
    </div>
    <${ActionsPanel} actor=${actor} persona=${persona} open=${open} />
    ${action && html`<${ActionModal} key=${modal.k} game=${game} actor=${actor} persona=${persona} action=${action} preset=${modal.preset} onClose=${() => setModal(null)} />`}
  </div>`;
}

