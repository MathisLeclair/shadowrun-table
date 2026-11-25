// GM side of « Progression »: pending requests, runners overview, downtime, workshop, history, settings.
import { useState } from 'preact/hooks';
import { html, Panel, Tabs, Button, Empty, Badge, Field, Select, NumberInput, TextInput, Toggle, confirmAction } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { toast, openSheet, goTab } from '../../lib/ui-store.js';
import { quote, formatDays, RULE_TEXT, KIND_LABELS } from '/shared/advancement.js';
import { nuyen } from '/shared/util.js';
import AdvancePanel from './AdvancePanel.js';
import { KarmaHeader, JobList, RequestList, ProgressBar, requestsOf, jobsOf, settingsOf, quoteContext, fmtDate } from './common.js';

const pcsOf = (game) =>
  Object.values(game.actors || {})
    .filter((a) => a && a.type === 'pc' && !a.retired)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'fr'));

export default function GmTraining({ game }) {
  const [tab, setTab] = useState('dash');
  const [workshopId, setWorkshopId] = useState(null);
  const pending = requestsOf(game).filter((r) => r.status === 'pending');
  const tabs = [
    { id: 'dash', label: 'Tableau de bord', badge: pending.length || null },
    { id: 'workshop', label: 'Atelier' },
    { id: 'history', label: 'Historique' },
    { id: 'settings', label: 'Réglages & règles' },
  ];
  const train = (id) => {
    setWorkshopId(id);
    setTab('workshop');
  };
  return html`<div class="page training-page">
    <div class="page-title">
      <h2>Progression</h2>
      <${Tabs} tabs=${tabs} value=${tab} onChange=${setTab} class="training-gm-tabs" />
    </div>
    ${tab === 'dash' && html`<${Dashboard} game=${game} pending=${pending} onTrain=${train} />`}
    ${tab === 'workshop' && html`<${Workshop} game=${game} actorId=${workshopId} setActorId=${setWorkshopId} />`}
    ${tab === 'history' && html`<${History} game=${game} />`}
    ${tab === 'settings' && html`<${Settings} game=${game} />`}
  </div>`;
}

// ---------------------------------------------------------------------------------------------
function Dashboard({ game, pending, onTrain }) {
  return html`<div class="training-dash">
    <div class="col gap-l">
      <${Panel} title=${`Demandes en attente${pending.length ? ` (${pending.length})` : ''}`}>
        ${pending.length
          ? html`<div class="col">${[...pending].sort((a, b) => a.ts - b.ts).map((r) => html`<${PendingCard} key=${r.id} game=${game} r=${r} />`)}</div>`
          : html`<div class="muted small training-empty">Aucune demande. Les runners peuvent dépenser leur karma depuis leur onglet Progression.</div>`}
      </${Panel}>
      <${Downtime} game=${game} />
    </div>
    <div class="col gap-l">
      <${Runners} game=${game} onTrain=${onTrain} />
      <${KarmaReward} game=${game} />
    </div>
  </div>`;
}

function PendingCard({ game, r }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const actor = game.actors?.[r.actorId];
  const recheck = actor ? quote(actor, r.request || r, settingsOf(game), quoteContext(game, actor, r.id)) : null;
  const resolve = async (approve) => {
    setBusy(true);
    try {
      const res = await send('training/resolve', { requestId: r.id, approve, note });
      toast(approve ? (res?.status === 'done' ? `${r.label} : acquis` : `${r.label} : entraînement lancé`) : 'Demande refusée', approve ? 'success' : 'warn');
    } catch {
      setBusy(false);
    }
  };
  return html`<div class="training-pending">
    <div class="row spread wrap gap-s">
      <span class="grow">
        <button class="training-link" onClick=${() => actor && openSheet(actor.id)}>${actor?.name || 'Personnage supprimé'}</button>
        <span class="faint small"> · ${KIND_LABELS[r.kind] || r.kind} · ${fmtDate(r.ts)}</span>
      </span>
      ${r.manual && html`<${Badge} color="magenta" title="Saisie manuelle : vérifie le coût">manuel</${Badge}>`}
    </div>
    <div class="training-pending-label">${r.label}</div>
    <div class="row wrap small gap-s">
      <span class="mono amber">${r.karmaCost} karma</span>
      <span class="muted">(dispo ${Number(actor?.karma) || 0})</span>
      ${r.days > 0 && html`<span>· ${formatDays(r.days)}</span>`}
      ${r.instructor && html`<span>· instructeur ${nuyen(r.nuyenCost)}</span>`}
      ${r.ppCost > 0 && html`<span>· ${r.ppCost} PP</span>`}
    </div>
    ${r.note && html`<div class="small training-note">« ${r.note} »</div>`}
    ${recheck?.error && html`<div class="training-warn small">⚠ ${recheck.error}</div>`}
    <div class="row wrap gap-s training-pending-actions">
      <div class="grow"><${TextInput} live value=${note} placeholder="Note au joueur (optionnel)" onChange=${setNote} /></div>
      <${Button} small variant="danger" disabled=${busy} onClick=${() => resolve(false)}>Refuser</${Button}>
      <${Button} small variant="primary" disabled=${busy || !!recheck?.error} title=${recheck?.error || ''} onClick=${() => resolve(true)}>Valider</${Button}>
    </div>
  </div>`;
}

function Downtime({ game }) {
  const [custom, setCustom] = useState(3);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  const elapsed = Number(game.training?.daysElapsed) || 0;
  const running = [];
  for (const a of Object.values(game.actors || {})) for (const j of jobsOf(a)) running.push({ actor: a, job: j, left: Math.max(0, (j.daysTotal || 0) - (j.daysDone || 0)) });
  running.sort((x, y) => x.left - y.left);
  const next = running[0];
  const advance = async (days) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await send('training/advanceDays', { days });
      setLast(res);
      toast(`Temps mort : ${formatDays(days)}${res.completed.length ? ` — ${res.completed.length} entraînement(s) terminé(s)` : ''}`, res.completed.length ? 'success' : 'info');
    } catch {}
    setBusy(false);
  };
  return html`<${Panel} title="Temps mort" actions=${html`<span class="small muted" title="Jours de temps mort écoulés depuis le début du suivi">Jour ${elapsed}</span>`}>
    <div class="small muted">Fait avancer le calendrier : tous les entraînements en cours progressent, ceux qui sont terminés s’appliquent aux fiches.</div>
    <div class="row wrap training-downtime">
      <${Button} disabled=${busy} onClick=${() => advance(1)}>+1 jour</${Button}>
      <${Button} disabled=${busy} onClick=${() => advance(7)}>+1 semaine</${Button}>
      <${Button} disabled=${busy} onClick=${() => advance(30)}>+1 mois</${Button}>
      <span class="row gap-s">
        <${NumberInput} small value=${custom} min=${1} max=${365} onChange=${setCustom} />
        <${Button} variant="primary" disabled=${busy} onClick=${() => advance(custom)}>Avancer</${Button}>
      </span>
    </div>
    ${next
      ? html`<div class="small">${running.length} entraînement(s) en cours · prochain : <strong>${next.actor.name}</strong> — ${next.job.label} <span class="muted">(dans ${formatDays(next.left)})</span></div>`
      : html`<div class="small muted">Aucun entraînement en cours.</div>`}
    ${last &&
    html`<div class="training-last">
      <div class="small"><strong>${formatDays(last.days)}</strong> écoulé(s) — ${last.completed.length ? `${last.completed.length} terminé(s) :` : 'rien de terminé.'}</div>
      ${last.completed.length > 0 && html`<ul class="small">${last.completed.map((c) => html`<li><span class="cyan">${c.actorName}</span> : ${c.label}</li>`)}</ul>`}
    </div>`}
  </${Panel}>`;
}

function Runners({ game, onTrain }) {
  const pcs = pcsOf(game);
  const npcsTraining = Object.values(game.actors || {}).filter((a) => a && a.type !== 'pc' && jobsOf(a).length);
  const list = [...pcs, ...npcsTraining];
  return html`<${Panel} title="Runners" actions=${html`<${Button} small variant="ghost" title="Fiches, karma et nuyens" onClick=${() => goTab('characters')}>Personnages →</${Button}>`}>
    ${list.length
      ? html`<div class="col">${list.map((a) => {
          const jobs = jobsOf(a);
          const pend = requestsOf(game, a.id).filter((r) => r.status === 'pending').length;
          return html`<div key=${a.id} class="training-runner">
            <div class="row spread wrap gap-s">
              <button class="training-link" onClick=${() => openSheet(a.id)}><strong>${a.name}</strong></button>
              <span class="row gap-s small">
                ${pend > 0 && html`<${Badge} color="amber">${pend} en attente</${Badge}>`}
                <span class="mono" title="Karma disponible / carrière"><span class="cyan">${Number(a.karma) || 0}</span><span class="faint"> / ${Number(a.karmaTotal) || 0} karma</span></span>
                <span class="mono magenta">${nuyen(a.nuyen)}</span>
                <${Button} small onClick=${() => onTrain(a.id)}>Entraîner</${Button}>
              </span>
            </div>
            ${jobs.map(
              (j) => html`<div key=${j.id} class="training-runner-job">
                <span class="small grow">${j.label}</span>
                <span class="small mono muted">${j.daysDone || 0}/${j.daysTotal} j</span>
                <${ProgressBar} value=${j.daysDone || 0} max=${j.daysTotal || 0} compact />
              </div>`
            )}
          </div>`;
        })}</div>`
      : html`<${Empty}>Aucun runner actif.</${Empty}>`}
  </${Panel}>`;
}

/** Quick end-of-run karma reward (characters module action 'actor/adjust'). */
function KarmaReward({ game }) {
  const pcs = pcsOf(game);
  const [karma, setKarma] = useState(3);
  const [reason, setReason] = useState('');
  const [excluded, setExcluded] = useState([]);
  const [busy, setBusy] = useState(false);
  const targets = pcs.filter((a) => !excluded.includes(a.id));
  const give = async () => {
    if (!targets.length || !karma) return;
    if (!(await confirmAction(`Donner ${karma} karma à ${targets.map((a) => a.name).join(', ')} ?`))) return;
    setBusy(true);
    try {
      await send('actor/adjust', { actorIds: targets.map((a) => a.id), karma, reason: reason.trim() || 'Récompense de run' });
      toast(`${karma} karma distribués`, 'success');
      setReason('');
    } catch {}
    setBusy(false);
  };
  if (!pcs.length) return null;
  return html`<${Panel} title="Récompense de karma">
    <div class="row wrap gap-s">
      ${pcs.map(
        (a) => html`<${Toggle} key=${a.id} label=${a.name} value=${!excluded.includes(a.id)}
          onChange=${(v) => setExcluded((ex) => (v ? ex.filter((x) => x !== a.id) : [...ex, a.id]))} />`
      )}
    </div>
    <div class="row wrap training-reward">
      <${NumberInput} value=${karma} min=${-50} max=${100} onChange=${setKarma} />
      <div class="grow"><${TextInput} live value=${reason} placeholder="Raison (ex. Run « Cleanup Crew »)" onChange=${setReason} /></div>
      <${Button} variant="accent" disabled=${busy || !targets.length || !karma} onClick=${give}>Donner</${Button}>
    </div>
  </${Panel}>`;
}

// ---------------------------------------------------------------------------------------------
function Workshop({ game, actorId, setActorId }) {
  const all = Object.values(game.actors || {}).filter(Boolean);
  const pcs = all.filter((a) => a.type === 'pc').sort((a, b) => String(a.name).localeCompare(String(b.name), 'fr'));
  const npcs = all.filter((a) => a.type !== 'pc').sort((a, b) => String(a.name).localeCompare(String(b.name), 'fr'));
  const id = actorId && game.actors?.[actorId] ? actorId : pcs.find((a) => !a.retired)?.id || pcs[0]?.id || npcs[0]?.id || '';
  const actor = id ? game.actors[id] : null;
  const options = [
    ...pcs.map((a) => ({ value: a.id, label: `${a.name}${a.retired ? ' (retraité)' : ''}` })),
    ...npcs.map((a) => ({ value: a.id, label: `PNJ · ${a.name}` })),
  ];
  if (!actor) return html`<${Empty}>Aucun personnage. Crée ou importe des fiches dans l’onglet Personnages.</${Empty}>`;
  return html`<div class="col gap-l">
    <div class="row wrap spread">
      <div class="row wrap">
        <${Field} label="Personnage"><${Select} value=${id} onChange=${setActorId} options=${options} /></${Field}>
        <${Button} small variant="ghost" onClick=${() => openSheet(actor.id)}>Ouvrir la fiche</${Button}>
      </div>
      <${KarmaHeader} game=${game} actor=${actor} />
    </div>
    <div class="small muted">Atelier MJ : tout ce que tu valides ici est appliqué directement (karma débité, entraînement lancé). Coche « Offert » dans la confirmation pour un gain sans coût.</div>
    <div class="training-layout">
      <${Panel} title=${`Progression de ${actor.name}`}>
        <${AdvancePanel} game=${game} actor=${actor} isGM=${true} />
      </${Panel}>
      <div class="col gap-l training-side">
        <${Panel} title="En cours"><${JobList} game=${game} actor=${actor} isGM=${true} /></${Panel}>
        <${Panel} title="Demandes"><${RequestList} game=${game} requests=${requestsOf(game, actor.id)} isGM=${true} limit=${20} /></${Panel}>
      </div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------------------------
function History({ game }) {
  const [actorId, setActorId] = useState('');
  const [status, setStatus] = useState('');
  const all = requestsOf(game);
  const list = all.filter((r) => (!actorId || r.actorId === actorId) && (!status || r.status === status));
  const actorIds = [...new Set(all.map((r) => r.actorId))];
  const closed = all.filter((r) => !['pending', 'approved'].includes(r.status) && (!actorId || r.actorId === actorId)).length;
  const clear = async () => {
    const who = actorId ? game.actors?.[actorId]?.name || 'ce personnage' : 'tous les personnages';
    if (!(await confirmAction(`Effacer les ${closed} demande(s) closes (acquises, refusées, annulées) de ${who} ?\nLes fiches ne sont pas modifiées.`))) return;
    send('training/clearHistory', actorId ? { actorId } : {}).then((r) => toast(`${r.removed} demande(s) effacée(s)`)).catch(() => {});
  };
  return html`<${Panel} title="Historique des demandes" actions=${html`<${Button} small variant="ghost" disabled=${!closed} onClick=${clear}>Purger les demandes closes</${Button}>`}>
    <div class="row wrap training-toolbar">
      <${Select} value=${actorId} onChange=${setActorId} options=${[{ value: '', label: 'Tous les personnages' }, ...actorIds.map((id) => ({ value: id, label: game.actors?.[id]?.name || '(supprimé)' }))]} />
      <${Select} value=${status} onChange=${setStatus} options=${[
        { value: '', label: 'Tous les statuts' },
        { value: 'pending', label: 'En attente' },
        { value: 'approved', label: 'En cours' },
        { value: 'done', label: 'Acquises' },
        { value: 'denied', label: 'Refusées' },
        { value: 'cancelled', label: 'Annulées' },
      ]} />
    </div>
    <${RequestList} game=${game} requests=${list} isGM=${true} showActor=${true} limit=${150} />
  </${Panel}>`;
}

// ---------------------------------------------------------------------------------------------
function Settings({ game }) {
  const s = settingsOf(game);
  const update = (patch) => send('training/updateSettings', patch).catch(() => {});
  const price = (k) => (n) => update({ instructorCostPerWeek: { [k]: n } });
  return html`<div class="grid-2">
    <${Panel} title="Réglages">
      <div class="col gap-l">
        <${Field} label="Validation des demandes" hint="En automatique, les saisies manuelles (hors catalogue) et « Autre » passent quand même par toi.">
          <${Select} value=${s.approval} onChange=${(v) => update({ approval: v })} options=${[
            { value: 'always', label: 'Le MJ valide chaque demande' },
            { value: 'never', label: 'Automatique' },
          ]} />
        </${Field}>
        <div class="col gap-s">
          <${Toggle} label="Temps d’entraînement (temps mort)" value=${s.useTime} onChange=${(v) => update({ useTime: v })} />
          <span class="field-hint">${s.useTime ? 'Les progressions validées prennent du temps : avance le calendrier dans « Temps mort ».' : 'Les progressions validées s’appliquent immédiatement.'}</span>
        </div>
        <${Field} label="Instructeur : réduction du temps (%)" hint="SR5 : chaque succès au test d’Enseignement réduit le temps. Ici une réduction fixe.">
          <${NumberInput} value=${s.instructorTimeReduction} min=${0} max=${90} step=${5} onChange=${(n) => update({ instructorTimeReduction: n })} />
        </${Field}>
        <div class="field">
          <span class="field-label">Instructeur : prix par semaine (¥)</span>
          <div class="training-prices">
            <span>Attributs</span><${NumberInput} value=${s.instructorCostPerWeek.attribute} min=${0} max=${100000} step=${100} onChange=${price('attribute')} />
            <span>Compétences & groupes</span><${NumberInput} value=${s.instructorCostPerWeek.skill} min=${0} max=${100000} step=${50} onChange=${price('skill')} />
            <span>Connaissances & langues</span><${NumberInput} value=${s.instructorCostPerWeek.knowledge} min=${0} max=${100000} step=${50} onChange=${price('knowledge')} />
            <span>Autres (qualités, magie…)</span><${NumberInput} value=${s.instructorCostPerWeek.other} min=${0} max=${100000} step=${50} onChange=${price('other')} />
          </div>
        </div>
      </div>
    </${Panel}>
    <${Panel} title="Règles SR5 appliquées">
      <ul class="training-rules">
        ${Object.entries(RULE_TEXT).map(([k, text]) => html`<li key=${k}><strong>${KIND_LABELS[k] || 'Instructeur'}</strong><div class="small muted">${text.replace(/^[^:]+ : /, '')}</div></li>`)}
        <li><strong>Limites</strong><div class="small muted">Attributs : maximum du métatype (+1 Attribut exceptionnel, +1 Chance pour Chanceux). Magie/Résonance : 6 + grade − essence perdue (arrondie au supérieur). Compétences : 12 (13 avec Aptitude). Un seul attribut à la fois ; pas deux entraînements sur la même chose.</div></li>
        <li><strong>Karma</strong><div class="small muted">Débité à la validation ; une demande en attente réserve son karma. Interrompre un entraînement (MJ) rembourse karma et instructeur.</div></li>
      </ul>
    </${Panel}>
  </div>`;
}
