// GM « Personnages »: runner cards, NPC actors on the field, creation, import, end-of-session rewards, rest.
import { useRef, useState } from 'preact/hooks';
import { html, Button, Badge, Select, NumberInput, TextInput, Empty, IconButton, confirmAction, promptText, loadCss } from '../../lib/ui.js';
import { send, api } from '../../lib/net.js';
import { openSheet, toast } from '../../lib/ui-store.js';
import { derive } from '/shared/sr5.js';
import { nuyen } from '/shared/util.js';
import { Avatar, MiniBar, Overlay, ownerOf, actorStatus, statusColor, EdgePips } from './common.js';
import { ChummerGmPanel } from '../chummer/ChummerActions.js';

loadCss('/modules/sheet/sheet.css');

function PcCard({ game, actor }) {
  const d = derive(actor);
  const c = actor.condition || {};
  const owner = ownerOf(game, actor.id);
  const online = owner && (game.online || []).includes(owner.id);
  const users = Object.values(game.users || {});
  const assign = (userId) => {
    if (!userId) {
      if (owner) send('users/assign', { userId: owner.id, characterId: actor.id, assign: false }).catch(() => {});
      return;
    }
    send('users/assign', { userId, characterId: actor.id, assign: true }).catch(() => {});
  };
  const status = actorStatus(actor);
  return html`<div class="card ch-card" style=${{ '--pc': actor.color || '#3fd6d0' }}>
    <div class="ch-card-top clickable" onClick=${() => openSheet(actor.id)} title="Ouvrir la fiche">
      <${Avatar} actor=${actor} size=${52} />
      <div class="grow">
        <h4>${actor.name}</h4>
        <div class="muted small ch-ellipsis">${actor.concept || actor.metatype}</div>
        <div class="row wrap gap-s small">
          <span class=${'sh-online' + (online ? ' on' : '')}>${owner ? owner.name : 'non attribué'}</span>
          ${actor.player && html`<span class="faint">(${actor.player})</span>`}
        </div>
      </div>
      ${status !== 'indemne' && html`<${Badge} color=${statusColor(status)}>${status}</${Badge}>`}
    </div>
    <div class="ch-bars">
      <${MiniBar} label="P" kind="physical" value=${c.physical || 0} max=${d.physicalMonitor} />
      <${MiniBar} label="É" kind="stun" value=${c.stun || 0} max=${d.stunMonitor} />
    </div>
    <div class="row spread wrap ch-stats">
      <span title="Karma disponible / carrière"><span class="faint">Karma</span> <b class="amber">${actor.karma}</b><span class="faint">/${actor.karmaTotal}</span></span>
      <span><span class="faint">¥</span> <b class="cyan">${nuyen(actor.nuyen)}</b></span>
      <span class="row gap-s"><span class="faint">Chance</span><${EdgePips} actor=${actor} canUse=${true} size="sm" /></span>
    </div>
    <div class="row ch-assign">
      <span class="faint small">Joueur</span>
      <${Select} value=${owner?.id || ''} options=${[{ value: '', label: '— personne —' }, ...users.map((u) => ({ value: u.id, label: u.name }))]} onChange=${assign} />
    </div>
  </div>`;
}

function NpcRow({ actor }) {
  const d = derive(actor);
  const c = actor.condition || {};
  const status = actorStatus(actor);
  const del = async () => {
    if (await confirmAction(`Supprimer ${actor.name} (et son pion) ?`)) send('actor/delete', { actorId: actor.id }).catch(() => {});
  };
  return html`<div class=${'ch-npc' + (status === 'mort' || status === 'hors de combat' ? ' down' : '')}>
    <${Avatar} actor=${actor} size=${28} />
    <button type="button" class="ch-npc-name" onClick=${() => openSheet(actor.id)} title="Ouvrir la fiche">${actor.name}</button>
    ${actor.hidden && html`<${Badge}>caché</${Badge}>`}
    <div class="ch-npc-bars">
      <${MiniBar} kind="physical" value=${c.physical || 0} max=${d.physicalMonitor} />
      <${MiniBar} kind="stun" value=${c.stun || 0} max=${d.stunMonitor} />
    </div>
    <${Badge} color=${statusColor(status)}>${status}</${Badge}>
    <${IconButton} icon="✕" title="Supprimer" onClick=${del} />
  </div>`;
}

function RewardsDialog({ game, onClose }) {
  const pcs = Object.values(game.actors).filter((a) => a.type === 'pc' && !a.retired && a.attributes);
  const [sel, setSel] = useState(() => new Set(pcs.map((a) => a.id)));
  const [karma, setKarma] = useState(5);
  const [ny, setNy] = useState(0);
  const [reason, setReason] = useState('Fin de séance');
  const [busy, setBusy] = useState(false);
  const toggle = (id) => {
    const n = new Set(sel);
    n.has(id) ? n.delete(id) : n.add(id);
    setSel(n);
  };
  const go = async () => {
    setBusy(true);
    try {
      await send('actor/adjust', { actorIds: [...sel], karma, nuyen: ny, reason });
      toast('Récompenses distribuées', 'success');
      onClose();
    } catch {
    } finally {
      setBusy(false);
    }
  };
  return html`<${Overlay} title="Récompenses de fin de séance" onClose=${onClose} width=${520}>
    <div class="col">
      <div class="ch-reward-pcs">
        ${pcs.map(
          (a) => html`<label class=${'ch-reward-pc' + (sel.has(a.id) ? ' on' : '')} key=${a.id} style=${{ '--pc': a.color || '#3fd6d0' }}>
            <input type="checkbox" checked=${sel.has(a.id)} onChange=${() => toggle(a.id)} />
            <${Avatar} actor=${a} size=${28} /><span>${a.name}</span>
          </label>`
        )}
      </div>
      <div class="row wrap">
        <div class="field"><span class="field-label">Karma (chacun)</span><${NumberInput} value=${karma} min=${-100} max=${100} onChange=${setKarma} /></div>
        <div class="field"><span class="field-label">Nuyens (chacun)</span><${NumberInput} value=${ny} min=${-1000000} max=${1000000} step=${500} onChange=${setNy} /></div>
      </div>
      <label class="field"><span class="field-label">Raison (historique et journal)</span><${TextInput} live value=${reason} onChange=${setReason} /></label>
      <div class="muted small">Le karma positif s’ajoute aussi au karma de carrière. Chaque runner reçoit une ligne dans son historique.</div>
      <div class="row spread">
        <span class="muted small">${sel.size} runner(s)</span>
        <div class="row">
          <${Button} variant="ghost" onClick=${onClose}>Annuler</${Button}>
          <${Button} variant="primary" disabled=${busy || !sel.size || (!karma && !ny)} onClick=${go}>Distribuer</${Button}>
        </div>
      </div>
    </div>
  </${Overlay}>`;
}

export default function CharactersPage({ game }) {
  const [rewards, setRewards] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const fileRef = useRef(null);
  const actors = Object.values(game.actors || {});
  const pcs = actors.filter((a) => a.type === 'pc' && !a.retired).sort((a, b) => a.name.localeCompare(b.name));
  const retired = actors.filter((a) => a.type === 'pc' && a.retired);
  const npcs = actors.filter((a) => a.type === 'npc');
  const groups = {};
  for (const a of npcs) (groups[a.templateId || ''] ||= []).push(a);
  const groupName = (tid) => (tid ? game.bestiary?.[tid]?.name || 'Modèle inconnu' : 'PNJ sans modèle');
  const unassigned = Object.values(game.users || {}).filter((u) => !(u.characterIds || []).some((id) => game.actors[id]));

  const create = async (type) => {
    const name = await promptText(type === 'pc' ? 'Nom du nouveau runner :' : 'Nom du PNJ :', '');
    if (!name || !name.trim()) return;
    try {
      const id = await send('actor/create', { type, name: name.trim() });
      openSheet(id);
    } catch {}
  };
  const importFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const res = await api(`/api/chummer/import?type=pc&fileName=${encodeURIComponent(file.name)}`, { method: 'POST', body: new Blob([text], { type: 'text/plain' }), headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      toast(`Fiche importée : ${game.actors?.[res.actorId]?.name || file.name}`, 'success');
      if (res.warnings?.length) toast(res.warnings[0], 'warn', 7000);
      openSheet(res.actorId);
    } catch (err) {
      toast(err.message || 'Import impossible', 'error');
    }
  };
  const rest = async () => {
    if (!(await confirmAction('Repos : recharger la Chance de tous les runners actifs et soigner leurs dommages étourdissants ?'))) return;
    try {
      await send('edge/refresh', { all: true });
      for (const a of pcs) if ((a.condition?.stun || 0) > 0) await send('actor/heal', { actorId: a.id, amount: a.condition.stun, type: 'S' });
      toast('Les runners ont récupéré', 'success');
    } catch {}
  };
  const clearGroup = async (list, label) => {
    if (!(await confirmAction(`Supprimer ${list.length} PNJ (${label}) et leurs pions ?`))) return;
    send('actor/delete', { actorIds: list.map((a) => a.id) }).catch(() => {});
  };

  return html`<div class="page ch-page">
    <div class="page-title">
      <h2>Personnages</h2>
      <div class="row wrap">
        <${Button} variant="primary" onClick=${() => setRewards(true)}>Récompenses de fin de séance</${Button}>
        <${Button} onClick=${rest} title="Recharge la Chance, soigne l’étourdissant">Repos</${Button}>
        <${Button} onClick=${() => create('pc')}>+ Runner</${Button}>
        <${Button} onClick=${() => create('npc')}>+ PNJ</${Button}>
        <${Button} variant="ghost" onClick=${() => fileRef.current?.click()} title="Fiche Chummer5a (.chum5) ou export JSON d’une fiche">Importer un .chum5</${Button}>
        <input ref=${fileRef} type="file" accept=".chum5,.json,.xml" hidden onChange=${importFile} />
      </div>
    </div>

    <${ChummerGmPanel} game=${game} />

    <h3 class="section-title">Runners (${pcs.length})</h3>
    ${pcs.length ? html`<div class="grid ch-grid">${pcs.map((a) => html`<${PcCard} game=${game} actor=${a} key=${a.id} />`)}</div>` : html`<${Empty}>Aucun runner actif.</${Empty}>`}
    ${unassigned.length > 0 && html`<div class="muted small ch-unassigned">Joueurs sans personnage : ${unassigned.map((u) => u.name).join(', ')} — attribue-leur un runner via le menu « Joueur » d’une carte.</div>`}

    ${retired.length > 0 && html`<div>
      <button type="button" class="ch-toggle" onClick=${() => setShowRetired(!showRetired)}>${showRetired ? '▾' : '▸'} Retraités (${retired.length})</button>
      ${showRetired && html`<div class="grid ch-grid">${retired.map((a) => html`<${PcCard} game=${game} actor=${a} key=${a.id} />`)}</div>`}
    </div>`}

    <div class="ch-npc-head">
      <h3 class="section-title">PNJ sur le terrain (${npcs.length})</h3>
      ${npcs.length > 0 && html`<${Button} small variant="danger" onClick=${() => clearGroup(npcs, 'tous')}>Tout supprimer</${Button}>`}
    </div>
    ${npcs.length
      ? html`<div class="ch-npc-groups">${Object.entries(groups)
          .sort(([a], [b]) => groupName(a).localeCompare(groupName(b)))
          .map(
            ([tid, list]) => html`<section class="panel ch-npc-group" key=${tid || 'none'}>
              <header class="panel-head"><h3>${groupName(tid)} <span class="faint">×${list.length}</span></h3>
                <div class="panel-actions"><${Button} small variant="ghost" onClick=${() => clearGroup(list, groupName(tid))}>Supprimer le groupe</${Button}></div></header>
              <div class="panel-body ch-npc-list">${list.sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true })).map((a) => html`<${NpcRow} actor=${a} key=${a.id} />`)}</div>
            </section>`
          )}</div>`
      : html`<${Empty}>Aucun PNJ en jeu. Fais apparaître des ennemis depuis le Bestiaire ou crée un PNJ.</${Empty}>`}

    ${rewards && html`<${RewardsDialog} game=${game} onClose=${() => setRewards(false)} />`}
  </div>`;
}

