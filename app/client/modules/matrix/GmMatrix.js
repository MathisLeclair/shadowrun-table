// GM Matrix screens: decker oversight (OS, damage, marks, convergence) and the hosts manager (templates, IC, files, devices).
import { useState } from 'preact/hooks';
import { html, Button, Badge, Field, NumberInput, Select, TextInput, Toggle, Empty, IconButton, confirmAction } from '../../lib/ui.js';
import { openSheet } from '../../lib/ui-store.js';
import { t, tn, compare } from '../../lib/i18n.js';
import { uid } from '/shared/util.js';
import {
  ASDF, ASDF_LABELS, ASDF_SHORT, MODE_LABELS, IC_TYPES, IC_ORDER, HOST_PRESETS, OS_MAX, hostAttributes, matrixMonitor,
  icInitiative, icAttackPool, deckStats, isCyberdeck,
} from '/shared/matrix.js';
import { act, personaOf, OsMeter, MatrixMonitor, marksDots, icName, markName, linkLockName, asdfShort, asdfLabel, modeLabel } from './common.js';
import { RuleRef } from '../books/BookRef.js';

// ---------------------------------------------------------------------------
// Deckers
// ---------------------------------------------------------------------------
function DeckerCard({ game, actor, onCockpit }) {
  const p = personaOf(game, actor);
  const ds = deckStats(actor, p);
  const host = p.hostId ? game.matrix?.hosts?.[p.hostId] : null;
  const set = (patch) => act('matrix/setPersona', { actorId: actor.id, patch });
  const converge = async () => {
    if (await confirmAction(t('Déclencher la convergence sur {name} ? 12 cases de dommages matriciels, deck redémarré de force, marques perdues, position révélée.', { name: actor.name }))) act('matrix/converge', { actorId: actor.id });
  };
  const dump = async () => {
    if (await confirmAction(t('Éjecter {name} de la Matrice (choc d’éjection en RV) ?', { name: actor.name }))) act('matrix/disconnect', { actorId: actor.id, dump: true });
  };
  const reset = async () => {
    if (await confirmAction(t('Réinitialiser complètement le persona de {name} (SO, marques, programmes chargés, agent) ?', { name: actor.name }))) act('matrix/resetPersona', { actorId: actor.id });
  };
  return html`<div class=${'mx-gm-decker' + (p.online ? ' online' : '') + ((p.overwatch || 0) >= 30 ? ' danger' : '')}>
    <div class="mx-gm-decker-head">
      <div class="grow">
        <button type="button" class="mx-link big" onClick=${() => openSheet(actor.id)}>${actor.name}</button>
        <div class="small muted">${actor.matrix.device || t('Appareil')} · ${t('indice {n}', { n: ds.deviceRating })} · ${isCyberdeck(actor) ? t('cyberdeck') : t('commlink')}</div>
      </div>
      ${p.online ? html`<${Badge} color="cyan">${modeLabel(p.mode)}</${Badge}>` : html`<${Badge}>${t('hors ligne')}</${Badge}>`}
      ${host && html`<${Badge} color="amber">${host.name}</${Badge}>`}
      ${p.bricked && html`<${Badge} color="red">${t('briqué')}</${Badge}>`}
    </div>
    <${OsMeter} value=${p.overwatch} compact />
    <div class="row wrap mx-gm-row">
      <${Field} label=${t('Score d’Overwatch')}><${NumberInput} small value=${p.overwatch || 0} min=${0} max=${OS_MAX} onChange=${(v) => act('matrix/setOverwatch', { actorId: actor.id, value: v })} /></${Field}>
      <${Field} label=${t('Bruit')}><${NumberInput} small value=${p.noise || 0} min=${0} max=${20} onChange=${(v) => set({ noise: v })} /></${Field}>
      <${Field} label=${t('Emplacements')}><${NumberInput} small value=${p.programSlots || 4} min=${1} max=${20} onChange=${(v) => set({ programSlots: v })} /></${Field}>
      <${Button} small variant="danger" onClick=${converge}>${t('Convergence')}</${Button}>
    </div>
    <${MatrixMonitor} value=${p.matrixDamage} deviceRating=${ds.deviceRating} onSet=${(n) => set({ matrixDamage: n })} />
    <div class="mx-chips">
      ${p.linkLocked && html`<span class="mx-chip-btn"><${Badge} color="red">${t('Verrou : {name}', { name: linkLockName(p.linkLocked) })}</${Badge}><button type="button" title=${t('Lever le verrou')} onClick=${() => set({ linkLocked: null })}>✕</button></span>`}
      ${p.fullDefense && html`<span class="mx-chip-btn"><${Badge} color="cyan">${t('Défense totale')}</${Badge}><button type="button" onClick=${() => set({ fullDefense: false })}>✕</button></span>`}
      ${p.traced && html`<span class="mx-chip-btn"><${Badge} color="magenta">${t('Localisé(e)')}</${Badge}><button type="button" onClick=${() => set({ traced: false })}>✕</button></span>`}
      ${Object.entries(p.penalties || {}).filter(([, v]) => v).map(([k, v]) => html`<span class="mx-chip-btn" key=${k}><${Badge} color="red">${asdfLabel(k)} −${v}</${Badge}><button type="button" onClick=${() => set({ penalties: { ...p.penalties, [k]: 0 } })}>✕</button></span>`)}
      ${p.agent && html`<${Badge} color=${p.agent.loaded ? 'green' : 'dim'}>◈ ${p.agent.name} (${p.agent.rating})${p.agent.damage ? ` ${p.agent.damage}/${matrixMonitor(p.agent.rating)}` : ''}</${Badge}>`}
    </div>
    ${(p.marks || []).length > 0 && html`<div class="mx-gm-marks"><span class="faint small">${t('Marques :')}</span>${p.marks.map((m) => html`<span class="mx-gm-mark" key=${m.targetId}>${markName(m)} ${marksDots(m.count)}<button type="button" title=${t('Retirer')} onClick=${() => act('matrix/setMarks', { actorId: actor.id, targetId: m.targetId, count: 0 })}>✕</button></span>`)}</div>`}
    ${(p.marksOnMe || []).length > 0 && html`<div class="mx-gm-marks"><span class="faint small">${t('Sur lui/elle :')}</span>${p.marksOnMe.map((m) => html`<span class="mx-gm-mark hostile" key=${m.sourceId}>${markName(m)} ${marksDots(m.count)}<button type="button" title=${t('Retirer')} onClick=${() => act('matrix/setMarkOnMe', { actorId: actor.id, sourceId: m.sourceId, count: 0 })}>✕</button></span>`)}</div>`}
    <div class="row wrap mx-gm-row">
      <${Button} small variant="primary" onClick=${() => onCockpit(actor.id)}>${t('Cockpit')}</${Button}>
      ${p.online && html`<${Button} small onClick=${dump}>${t('Éjecter')}</${Button}>`}
      ${p.bricked && html`<${Button} small onClick=${() => set({ matrixDamage: 0, bricked: false })}>${t('Réparer le deck')}</${Button}>`}
      <${Button} small variant="ghost" onClick=${reset}>${t('Réinitialiser')}</${Button}>
    </div>
  </div>`;
}

export function DeckersView({ game, onCockpit }) {
  const actors = Object.values(game.actors || {}).filter((a) => a && a.matrix && a.attributes && !a.retired && (isCyberdeck(a) || game.matrix?.personas?.[a.id]));
  actors.sort((a, b) => (a.type === b.type ? compare(a.name, b.name) : a.type === 'pc' ? -1 : 1));
  if (!actors.length) return html`<${Empty}>${t('Aucun decker : un personnage avec un cyberdeck (Attaque/Corruption) apparaît ici, ou dès qu’un commlink se connecte.')}</${Empty}>`;
  return html`<div class="mx-gm-grid">${actors.map((a) => html`<${DeckerCard} key=${a.id} game=${game} actor=${a} onCockpit=${onCockpit} />`)}</div>`;
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------
function NewHost({ onCreated }) {
  const [name, setName] = useState('');
  const [rating, setRating] = useState(4);
  const [preset, setPreset] = useState('shell');
  const [ic, setIc] = useState(true);
  const attrs = hostAttributes(rating, preset);
  const create = async () => {
    const r = await act('matrix/hostCreate', { name: name.trim() || t('Hôte {n}', { n: rating }), rating, preset, ic });
    if (r) {
      setName('');
      onCreated(r.id);
    }
  };
  return html`<div class="mx-gm-new">
    <div class="mx-panel-title">${t('Nouvel hôte')}</div>
    <${Field} label=${t('Nom')}><${TextInput} live value=${name} onChange=${setName} placeholder=${t('ex. Bureau de Renraku Tacoma')} /></${Field}>
    <div class="row wrap">
      <${Field} label=${t('Indice')}><${NumberInput} small value=${rating} min=${1} max=${12} onChange=${setRating} /></${Field}>
      <${Field} label=${t('Profil')} class="grow"><${Select} value=${preset} options=${Object.entries(HOST_PRESETS).map(([v, p]) => ({ value: v, label: t(p.label) }))} onChange=${setPreset} /></${Field}>
    </div>
    <div class="mx-host-attrs">${ASDF.map((k) => html`<span key=${k}>${asdfShort(k)} <b>${attrs[k]}</b></span>`)}</div>
    <${Toggle} value=${ic} onChange=${setIc} label=${t('Suite d’IC standard (Patrouille active)')} />
    <${Button} variant="primary" onClick=${create}>${t('Créer l’hôte')}</${Button}>
  </div>`;
}

function IcSection({ game, host }) {
  const [type, setType] = useState('killer');
  const inside = Object.values(game.matrix?.personas || {}).filter((p) => p.online && p.hostId === host.id);
  const [targets, setTargets] = useState({});
  const ini = icInitiative(host);
  return html`<div class="mx-gm-section">
    <div class="mx-panel-title spread"><span>${t('IC')} <${RuleRef} rule="ic" /></span><span class="faint small">${t('attaque {n} dés · init. {init}', { n: icAttackPool(host), init: ini.text })}</span></div>
    ${host.ic.length === 0 && html`<div class="muted small">${t('Aucune IC.')}</div>`}
    ${host.ic.map((ic) => {
      const def = IC_TYPES[ic.type] || {};
      const tgt = targets[ic.id] || inside[0]?.actorId || '';
      return html`<div class=${'mx-gm-ic' + (ic.active ? ' on' : '') + (ic.crashed ? ' crashed' : '')} key=${ic.id}>
        <div class="grow"><b title=${def.desc ? t(def.desc) : ''}>${icName(ic.type)}</b> <span class="faint small">${def.desc ? t(def.desc) : ''}${def.needsMarks ? ` ${tn(def.needsMarks, 'one::({n} marque(s) requise(s))', '({n} marque(s) requise(s))')}` : ''}</span></div>
        <${Field} label=${t('Indice')}><${NumberInput} small value=${ic.rating} min=${1} max=${12} onChange=${(v) => act('matrix/icUpdate', { hostId: host.id, icId: ic.id, patch: { rating: v } })} /></${Field}>
        <${Field} label=${t('Dommages /{n}', { n: matrixMonitor(ic.rating) })}><${NumberInput} small value=${ic.damage || 0} min=${0} max=${matrixMonitor(ic.rating)} onChange=${(v) => act('matrix/icUpdate', { hostId: host.id, icId: ic.id, patch: { damage: v } })} /></${Field}>
        ${ic.active
          ? html`<div class="row gap-s">
              ${inside.length > 0
                ? html`<select class="input mx-gm-tgt" value=${tgt} onChange=${(e) => setTargets({ ...targets, [ic.id]: e.target.value })}>
                    ${inside.map((p) => html`<option value=${p.actorId}>${game.actors?.[p.actorId]?.name || p.actorId}</option>`)}
                  </select>
                  <${Button} small variant="danger" onClick=${() => act('matrix/icAct', { hostId: host.id, icId: ic.id, actorId: tgt })}>${t('Attaquer')}</${Button}>`
                : html`<span class="faint small">${t('personne dans l’hôte')}</span>`}
              <${Button} small variant="ghost" onClick=${() => act('matrix/icUpdate', { hostId: host.id, icId: ic.id, patch: { active: false } })}>${t('Retirer')}</${Button}>
            </div>`
          : html`<${Button} small variant="accent" onClick=${() => act('matrix/icLaunch', { hostId: host.id, icId: ic.id })}>${ic.crashed ? t('Relancer') : t('ic::Lancer')}</${Button}>`}
        <${IconButton} icon="✕" title=${t('Supprimer cette IC')} onClick=${() => act('matrix/icRemove', { hostId: host.id, icId: ic.id })} />
      </div>`;
    })}
    <div class="row wrap">
      <${Select} value=${type} options=${IC_ORDER.map((x) => ({ value: x, label: icName(x) }))} onChange=${setType} />
      <${Button} small variant="accent" onClick=${() => act('matrix/icLaunch', { hostId: host.id, type })}>${t('Ajouter et lancer')}</${Button}>
    </div>
  </div>`;
}

function FilesSection({ host }) {
  const [openId, setOpenId] = useState(null);
  const save = (files) => act('matrix/hostUpdate', { hostId: host.id, patch: { files } });
  const upd = (id, patch) => save(host.files.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  return html`<div class="mx-gm-section">
    <div class="mx-panel-title">${t('Fichiers')}</div>
    ${host.files.length === 0 && html`<div class="muted small">${t('Aucun fichier.')}</div>`}
    ${host.files.map((f) => html`<div class="mx-gm-file" key=${f.id}>
      <div class="row wrap">
        <${TextInput} value=${f.name} onChange=${(v) => upd(f.id, { name: v })} class="grow" />
        <${Toggle} value=${f.protected} onChange=${(v) => upd(f.id, { protected: v, protection: v && !f.protection ? host.rating : f.protection })} label=${t('Protégé')} />
        ${f.protected && html`<${Field} label=${t('Protection')}><${NumberInput} small value=${f.protection || host.rating} min=${1} max=${12} onChange=${(v) => upd(f.id, { protection: v })} /></${Field}>`}
        <${Field} label=${t('Bombe')}><${NumberInput} small value=${f.bomb || 0} min=${0} max=${12} onChange=${(v) => upd(f.id, { bomb: v, bombBy: v ? f.bombBy : null })} /></${Field}>
        <${Field} label=${t('Valeur ¥')}><${NumberInput} small value=${f.value || 0} min=${0} max=${1000000} step=${100} onChange=${(v) => upd(f.id, { value: v })} /></${Field}>
        <${Button} small variant="ghost" onClick=${() => setOpenId(openId === f.id ? null : f.id)}>${openId === f.id ? t('Fermer') : t('Contenu')}</${Button}>
        <${IconButton} icon="✕" title=${t('Supprimer')} onClick=${() => save(host.files.filter((x) => x.id !== f.id))} />
      </div>
      ${f.edited && html`<span class="small amber">${t('modifié par un hacker')}</span>`}
      ${openId === f.id && html`<${TextInput} multiline rows=${3} value=${f.content || ''} placeholder=${t('Ce que le decker découvre en lisant ou copiant le fichier')} onChange=${(v) => upd(f.id, { content: v })} />`}
    </div>`)}
    <${Button} small onClick=${() => save([...host.files, { id: uid('file'), name: t('Nouveau fichier'), protected: false, bomb: 0, value: null, content: '' }])}>${t('Ajouter un fichier')}</${Button}>
  </div>`;
}

function DevicesSection({ host }) {
  const save = (devices) => act('matrix/hostUpdate', { hostId: host.id, patch: { devices } });
  const upd = (id, patch) => save(host.devices.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  return html`<div class="mx-gm-section">
    <div class="mx-panel-title">${t('Appareils esclaves')}</div>
    ${host.devices.length === 0 && html`<div class="muted small">${t('Aucun appareil.')}</div>`}
    ${host.devices.map((d) => html`<div class="row wrap mx-gm-file" key=${d.id}>
      <${TextInput} value=${d.name} onChange=${(v) => upd(d.id, { name: v })} class="grow" />
      <${Field} label=${t('Indice')}><${NumberInput} small value=${d.rating} min=${1} max=${12} onChange=${(v) => upd(d.id, { rating: v })} /></${Field}>
      <${Toggle} value=${d.offline} onChange=${(v) => upd(d.id, { offline: v })} label=${t('Hors ligne')} />
      ${d.formatted && html`<${Badge} color="red">${t('formaté')}</${Badge}>`}
      ${d.bricked && html`<${Badge} color="red">${t('briqué')}</${Badge}>`}
      ${(d.formatted || d.bricked || d.damage) ? html`<${Button} small variant="ghost" onClick=${() => upd(d.id, { formatted: false, bricked: false, damage: 0 })}>${t('Réparer')}</${Button}>` : null}
      <${IconButton} icon="✕" title=${t('Supprimer')} onClick=${() => save(host.devices.filter((x) => x.id !== d.id))} />
    </div>`)}
    <${Button} small onClick=${() => save([...host.devices, { id: uid('dev'), name: t('Nouvel appareil'), rating: host.rating }])}>${t('Ajouter un appareil')}</${Button}>
  </div>`;
}

function HostEditor({ game, host, onDeleted }) {
  const upd = (patch) => act('matrix/hostUpdate', { hostId: host.id, patch });
  const [preset, setPreset] = useState('shell');
  const spiders = Object.entries(game.bestiary || {}).map(([id, t]) => ({ value: id, label: t.name })).sort((a, b) => compare(a.label, b.label));
  const spiderOpts = [{ value: '', label: t('— aucune —') }, ...spiders];
  const deckers = Object.values(game.actors || {}).filter((a) => a && a.matrix && isCyberdeck(a) && !a.retired);
  const inside = Object.values(game.matrix?.personas || {}).filter((p) => p.online && p.hostId === host.id);
  const del = async () => {
    if (await confirmAction(t('Supprimer l’hôte « {name} » ? Les marques posées dessus disparaissent.', { name: host.name }))) {
      await act('matrix/hostDelete', { hostId: host.id });
      onDeleted();
    }
  };
  return html`<div class=${'mx-gm-host' + (host.alert === 'active' ? ' alert' : '')}>
    <div class="row wrap">
      <${Field} label=${t('Nom')} class="grow"><${TextInput} value=${host.name} onChange=${(v) => upd({ name: v })} /></${Field}>
      <${Field} label=${t('Dossier')}><${TextInput} value=${host.folder || ''} onChange=${(v) => upd({ folder: v })} /></${Field}>
    </div>
    <div class="row wrap">
      <${Toggle} value=${host.alert === 'active'} onChange=${(v) => upd({ alert: v ? 'active' : 'none' })} label=${t('Alerte')} />
      <${Toggle} value=${host.visible} onChange=${(v) => upd({ visible: v })} label=${t('Visible des joueurs (repéré sur la grille)')} />
    </div>
    <div class="row wrap mx-gm-row">
      <${Field} label=${t('Indice')}><${NumberInput} small value=${host.rating} min=${1} max=${12} onChange=${(v) => upd({ rating: v })} /></${Field}>
      ${ASDF.map((k) => html`<${Field} label=${asdfLabel(k)} key=${k}><${NumberInput} small value=${host[k]} min=${0} max=${20} onChange=${(v) => upd({ [k]: v })} /></${Field}>`)}
    </div>
    <div class="row wrap">
      <${Select} value=${preset} options=${Object.entries(HOST_PRESETS).map(([v, p]) => ({ value: v, label: t(p.label) }))} onChange=${setPreset} />
      <${Button} small variant="ghost" onClick=${() => upd(hostAttributes(host.rating, preset))}>${t('Recalculer les attributs (indice {n})', { n: host.rating })}</${Button}>
    </div>
    <div class="grid-2">
      <${Field} label=${t('Araignée de garde')}><${Select} value=${host.spider || ''} options=${spiderOpts} onChange=${(v) => upd({ spider: v || null })} /></${Field}>
      <${Field} label=${t('Araignée en alerte')}><${Select} value=${host.spiderAlert || ''} options=${spiderOpts} onChange=${(v) => upd({ spiderAlert: v || null })} /></${Field}>
    </div>
    ${(host.alert === 'active' ? host.spiderAlert || host.spider : host.spider) && html`<div class="small amber">${t('Araignée en poste : {name} (à placer depuis le Bestiaire)', { name: game.bestiary?.[host.alert === 'active' ? host.spiderAlert || host.spider : host.spider]?.name || '?' })}</div>`}
    <${Field} label=${t('Description (visible des deckers)')}><${TextInput} multiline rows=${2} value=${host.description || ''} onChange=${(v) => upd({ description: v })} /></${Field}>
    <${Field} label=${t('Notes du MJ')}><${TextInput} multiline rows=${4} value=${host.notes || ''} onChange=${(v) => upd({ notes: v })} /></${Field}>

    <div class="mx-gm-section">
      <div class="mx-panel-title">${t('Deckers')}</div>
      ${inside.length ? html`<div class="small">${t('Dans l’hôte : {names}', { names: inside.map((p) => game.actors?.[p.actorId]?.name).join(', ') })}</div>` : html`<div class="muted small">${t('Personne dans l’hôte.')}</div>`}
      <div class="row wrap">
        ${deckers.map((a) => {
          const seen = (host.perceivedBy || []).includes(a.id);
          return html`<${Toggle} key=${a.id} value=${seen} onChange=${(v) => upd({ perceivedBy: v ? [...(host.perceivedBy || []), a.id] : (host.perceivedBy || []).filter((x) => x !== a.id) })} label=${t('{name} connaît l’hôte', { name: a.name })} title=${t('Révèle indice, IC, fichiers et appareils à ce decker (comme une Perception matricielle)')} />`;
        })}
      </div>
    </div>
    <${IcSection} game=${game} host=${host} />
    <${FilesSection} host=${host} />
    <${DevicesSection} host=${host} />
    <div class="row spread mx-gm-row"><span></span><${Button} small variant="danger" onClick=${del}>${t('Supprimer l’hôte')}</${Button}></div>
  </div>`;
}

export function HostsView({ game, selected, onSelect }) {
  const hosts = Object.values(game.matrix?.hosts || {}).sort((a, b) => compare(a.folder || '', b.folder || '') || compare(a.name, b.name));
  const cur = hosts.find((h) => h.id === selected) || null;
  const personas = Object.values(game.matrix?.personas || {});
  return html`<div class="mx-gm-hosts">
    <aside class="mx-gm-hostlist">
      ${hosts.map((h) => {
        const n = personas.filter((p) => p.online && p.hostId === h.id).length;
        return html`<button type="button" key=${h.id} class=${'mx-gm-hostbtn' + (h.id === selected ? ' on' : '') + (h.alert === 'active' ? ' alert' : '')} onClick=${() => onSelect(h.id)}>
          <span class="grow"><b>${h.name}</b><small class="faint">${h.folder ? `${h.folder} · ` : ''}${t('indice {n}', { n: h.rating })} · ${h.attack}/${h.sleaze}/${h.dataProcessing}/${h.firewall}</small></span>
          ${h.alert === 'active' && html`<${Badge} color="red">${t('alerte')}</${Badge}>`}
          ${!h.visible && html`<span class="faint small" title=${t('Invisible des joueurs')}>◌</span>`}
          ${n > 0 && html`<${Badge} color="cyan">${n}</${Badge}>`}
        </button>`;
      })}
      <${NewHost} onCreated=${onSelect} />
    </aside>
    <section class="mx-gm-hostmain">
      ${cur ? html`<${HostEditor} key=${cur.id} game=${game} host=${cur} onDeleted=${() => onSelect(null)} />` : html`<${Empty}>${t('Choisis un hôte à gauche, ou crée-en un depuis un profil standard.')}</${Empty}>`}
    </section>
  </div>`;
}
