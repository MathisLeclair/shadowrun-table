// « Lancer » dialog for a Matrix action: target, marks, modifiers, Edge, and the agent (assist or act alone).
import { useState } from 'preact/hooks';
import { html, Modal, Button, Field, NumberInput, Select, TextInput, Toggle, Badge } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { DiceFaces } from '../sheet/common.js';
import { t, tn, tk, getLang } from '../../lib/i18n.js';
import { slug } from '/shared/util.js';
import {
  actionPool, isIllegal, ACTION_TYPES, ACTION_CATS, MARK_PENALTY, matrixMonitor,
} from '/shared/matrix.js';
import { isGM, targetOptions, marksRequired, msgText, outcomeTexts, partLabel, actionName, marksText, assistText } from './common.js';
import { useModifiers, toggleText, effectText, loadRollToggles, saveRollToggles } from '../sheet/modifiers-ui.js';
import { BookRef, SkillRef } from '../books/BookRef.js';

const FILE_OPS = [
  { value: 'read', label: tk('Lire') },
  { value: 'copy', label: tk('Copier dans mon deck') },
  { value: 'edit', label: tk('Modifier') },
  { value: 'delete', label: tk('fichier::Effacer') },
];

function PoolLine({ pc, title }) {
  if (!pc) return null;
  return html`<div class="mx-pool">
    <div class="mx-pool-main"><span class="mx-pool-n">${pc.pool}</span><span class="mx-pool-u">${t('dés')}</span>${pc.limit !== null && pc.limit !== undefined ? html`<span class="mx-pool-lim">[${pc.limit}]</span>` : html`<span class="mx-pool-lim faint">${t('sans limite')}</span>`}</div>
    <div class="mx-pool-parts">${title && html`<b>${t('{title} : ', { title })}</b>`}${pc.parts.map((p, i) => html`<span key=${i}>${partLabel(p)} <b class=${p.value < 0 ? 'red' : ''}>${p.value >= 0 ? '+' : '−'}${Math.abs(p.value)}</b>${p.mod?.book ? html` <${BookRef} source=${p.mod.book} page=${p.mod.page} />` : null}</span>`)}
      ${pc.limitParts?.length ? html`<span class="faint">· ${t('limite : {parts}', { parts: pc.limitParts.map((p) => `${partLabel(p)} ${p.value}`).join(' + ') })}</span>` : null}
    </div>
  </div>`;
}

function ResultView({ res, who }) {
  if (!res) return null;
  const r = res.roll;
  return html`<div class=${'mx-result' + (res.success === true ? ' ok' : res.success === false ? ' ko' : '')}>
    <div class="mx-result-head">
      <span class="mx-result-who">${who}</span>
      ${r && html`<span class="mx-result-hits">${r.hits}<small> ${t('succès')}</small></span>`}
      ${res.defense && html`<span class="mx-result-vs">${t('contre')} <b>${res.defense.hits}</b> (${res.defense.labelMsg ? msgText(res.defense.labelMsg) : res.defense.label}${res.defense.pool !== undefined ? `, ${t('{n} dés', { n: res.defense.pool })}` : ''})</span>`}
      ${res.success === true && html`<${Badge} color="green">${t('Réussite')}</${Badge}>`}
      ${res.success === false && html`<${Badge} color="red">${t('Échec')}</${Badge}>`}
      ${res.pending && html`<${Badge} color="amber">${t('Défense au MJ')}</${Badge}>`}
      ${res.osDelta ? html`<${Badge} color="magenta">${t('SO +{n}', { n: res.osDelta })}</${Badge}>` : null}
    </div>
    ${r && html`<${DiceFaces} roll=${r} />`}
    ${res.defense?.dice && html`<div class="mx-result-def"><span class="faint small">${t('Défense')}</span><${DiceFaces} roll=${{ dice: res.defense.dice }} small /></div>`}
    <ul class="mx-result-out">${outcomeTexts(res).map((o, i) => html`<li key=${i}>${o}</li>`)}</ul>
    ${res.convergence && html`<div class="mx-os-alarm">${t('CONVERGENCE — {text}', { text: (Array.isArray(res.convergenceMsgs) ? res.convergenceMsgs.map(msgText) : res.convergence).slice(1).join(' ') })}</div>`}
  </div>`;
}

export default function ActionModal({ game, actor, persona, action, preset = {}, onClose }) {
  const gm = isGM(game);
  const groups = targetOptions(game, actor, persona, action);
  const flat = groups.flatMap((g) => g.items);
  const needsTarget = !(action.targets || []).includes('none');
  const [targetId, setTargetId] = useState(preset.targetId && flat.some((o) => o.id === preset.targetId) ? preset.targetId : needsTarget ? flat[0]?.id || '' : '');
  const [targetName, setTargetName] = useState('');
  const [defensePool, setDefensePool] = useState(0);
  const [marks, setMarks] = useState(1);
  const [controlMarks, setControlMarks] = useState(1);
  const [fileOp, setFileOp] = useState(preset.fileOp || 'copy');
  const [command, setCommand] = useState('');
  const [program, setProgram] = useState('');
  const [threshold, setThreshold] = useState(0);
  const [modifier, setModifier] = useState(0);
  const [useSpec, setUseSpec] = useState(false);
  const [edge, setEdge] = useState(false);
  const [useAssist, setUseAssist] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { who, res }
  const [assistRes, setAssistRes] = useState(null);
  // Modifiers of the decker's gear / qualities / implants (Codeslinger, skill bonuses…) and the situational switches (shared with the roll dialog).
  const mods = useModifiers(actor);
  const [conds, setConds] = useState(() => loadRollToggles(actor.id));
  const setCond = (k, on) => {
    const next = on ? [...new Set([...conds, k])] : conds.filter((x) => x !== k);
    setConds(next);
    saveRollToggles(actor.id, next);
  };

  const ag = persona.agent;
  const pending = persona.pendingAssist && persona.pendingAssist.skill === action.skill ? persona.pendingAssist : null;
  const assist = useAssist && pending ? { dice: pending.dice, limitBonus: pending.limitBonus } : null;
  const sk = (actor.skills || []).find((s) => s.id === action.skill);
  const edgeLeft = actor.edge?.current ?? 0;
  const pc = action.noTest ? null : actionPool(actor, persona, action, { useSpec, marks, modifier, assist, edge, mods, conditions: conds });
  const switches = {};
  for (const l of pc?.modLines || []) if (!l.mod.baked && !l.mod.info && l.value !== null) for (const k of l.toggles || []) (switches[k] ||= []).push(l);
  const agentPc = action.noTest || !ag ? null : actionPool(actor, persona, action, { agent: true, marks, modifier });
  const target = flat.find((o) => o.id === targetId);
  const need = marksRequired(action, { controlMarks });
  let have = target?.marks || 0;
  if (targetId === 'manual') have = (persona.marks || []).find((m) => m.targetId === `manual:${slug(targetName.trim() || 'cible inconnue') || 'cible'}`)?.count || 0;
  const marksOk = have >= need;
  const canAgent = ag && !action.noTest && action.id !== 'jackOut';
  const missingTarget = needsTarget && !(targetId === 'manual' || flat.some((o) => o.id === targetId));
  const linkLockedJackOut = action.id === 'jackOut' && !persona.linkLocked;
  const offline = !persona.online && action.id !== 'rebootSelf';

  const payload = () => ({
    actorId: actor.id, actionId: action.id, targetId: targetId || undefined,
    targetName: targetId === 'manual' ? targetName : undefined,
    defensePool: targetId === 'manual' && gm ? defensePool : undefined,
    marks, controlMarks, fileOp, command: command || undefined, program: program || undefined,
    threshold: threshold || undefined, modifier,
  });

  const run = async () => {
    setBusy(true);
    try {
      const res = await send('matrix/action', { ...payload(), useSpec, edge, assistFromAgent: !!assist, conditions: conds });
      setResult({ who: actor.name, res });
      setUseAssist(false);
      setEdge(false);
    } catch {}
    setBusy(false);
  };
  const askAssist = async () => {
    setBusy(true);
    try {
      const res = await send('matrix/agentAssist', { actorId: actor.id, actionId: action.id });
      setAssistRes(res);
      setUseAssist(!!res.pendingAssist && res.pendingAssist.dice + res.pendingAssist.limitBonus > 0);
    } catch {}
    setBusy(false);
  };
  const agentDo = async () => {
    setBusy(true);
    try {
      const res = await send('matrix/agentAct', payload());
      setResult({ who: ag.name, res });
    } catch {}
    setBusy(false);
  };

  const legal = !isIllegal(action);
  return html`<${Modal} title=${actionName(action)} onClose=${onClose} width=${680}>
    <div class="mx-modal">
      <div class="row wrap gap-s mx-modal-tags">
        ${getLang() === 'fr' ? html`<span class="faint">${action.en}</span>` : null}
        <${Badge} color=${legal ? 'green' : 'magenta'}>${legal ? t('Légale') : t('Illégale')}</${Badge}>
        <${Badge}>${t(ACTION_CATS[action.cat])}</${Badge}>
        <${Badge}>${ACTION_TYPES[action.type] ? t(ACTION_TYPES[action.type]) : action.type}</${Badge}>
        ${need ? html`<${Badge} color=${marksOk ? 'cyan' : 'red'}>${tn(need, '{n} marque requise', '{n} marques requises')}</${Badge}>` : null}
        ${action.page ? html`<${BookRef} source="SR5" page=${action.page} />` : null}${action.skill ? html`<${SkillRef} id=${action.skill} />` : null}
      </div>
      <p class="mx-desc">${t(action.desc)}</p>
      ${!legal && html`<p class="small magenta">${t('Action illégale : les succès du défenseur s’ajoutent à ton Score d’Overwatch.')}</p>`}

      ${result
        ? html`<${ResultView} res=${result.res} who=${result.who} />
          <div class="row spread mx-modal-actions">
            <${Button} variant="ghost" onClick=${() => { setResult(null); setAssistRes(null); }}>${t('Nouvelle tentative')}</${Button}>
            <${Button} variant="primary" onClick=${onClose}>${t('Fermer')}</${Button}>
          </div>`
        : html`
          ${needsTarget || (action.targets || []).length > 1
            ? html`<div class="grid-2 mx-modal-grid">
                <${Field} label=${t('Cible')}>
                  ${flat.length
                    ? html`<select class="input" value=${targetId} onChange=${(e) => setTargetId(e.target.value)}>
                        ${!needsTarget && html`<option value="">${t('— Sans cible —')}</option>`}
                        ${groups.map((g) => html`<optgroup label=${g.group}>${g.items.map((o) => html`<option value=${o.id}>${o.label}${o.marks ? ` · ${marksText(o.marks)}` : ''}</option>`)}</optgroup>`)}
                      </select>`
                    : html`<div class="muted small">${t('Aucune cible disponible pour l’instant.')}</div>`}
                </${Field}>
                ${targetId === 'manual' && html`<${Field} label=${t('Nom de la cible')}><${TextInput} live value=${targetName} placeholder=${t('ex. commlink du garde')} onChange=${setTargetName} /></${Field}>`}
                ${targetId === 'manual' && gm && html`<${Field} label=${t('Défense (dés, MJ)')} hint=${t('0 = la cible ne résiste pas')}><${NumberInput} value=${defensePool} min=${0} max=${40} onChange=${setDefensePool} /></${Field}>`}
              </div>`
            : null}
          ${need > 0 && !marksOk && html`<p class="small red">${tn(need, 'Il te faut {n} marque sur cette cible (tu en as {have}).', 'Il te faut {n} marques sur cette cible (tu en as {have}).', { have })}</p>`}

          <div class="row wrap mx-modal-opts">
            ${action.placesMarks && html`<${Field} label=${t('Marques à placer')}>
              <div class="mx-seg">${[1, 2, 3].map((n) => html`<button type="button" class=${marks === n ? 'on' : ''} onClick=${() => setMarks(n)}>${n}${MARK_PENALTY[n] ? html` <small>(${MARK_PENALTY[n]})</small>` : ''}</button>`)}</div>
            </${Field}>`}
            ${action.id === 'controlDevice' && html`<${Field} label=${t('Marques exigées par l’ordre')}><div class="mx-seg">${[1, 2, 3].map((n) => html`<button type="button" class=${controlMarks === n ? 'on' : ''} onClick=${() => setControlMarks(n)}>${n}</button>`)}</div></${Field}>`}
            ${action.id === 'editFile' && html`<${Field} label=${t('Opération')}><${Select} value=${fileOp} options=${FILE_OPS.map((o) => ({ ...o, label: t(o.label) }))} onChange=${setFileOp} /></${Field}>`}
            ${['controlDevice', 'spoofCommand'].includes(action.id) || (action.id === 'editFile' && fileOp === 'edit')
              ? html`<${Field} label=${action.id === 'editFile' ? t('Modification') : t('Commande')} class="grow"><${TextInput} live value=${command} placeholder=${action.id === 'editFile' ? t('ex. ajouter un nom') : t('ex. ouvrir la porte')} onChange=${setCommand} /></${Field}>`
              : null}
            ${action.id === 'crashProgram' && html`<${Field} label=${t('Programme visé (optionnel)')}><${TextInput} live value=${program} onChange=${setProgram} /></${Field}>`}
            ${(action.id === 'matrixSearch' || (!action.defense && !action.noTest && action.id !== 'jamSignals')) && html`<${Field} label=${t('Seuil (optionnel)')}><${NumberInput} value=${threshold} min=${0} max=${20} onChange=${setThreshold} /></${Field}>`}
            ${!action.noTest && html`<${Field} label=${t('Modificateur')}><${NumberInput} value=${modifier} min=${-20} max=${20} onChange=${setModifier} /></${Field}>`}
          </div>
          ${!action.noTest && html`<div class="row wrap mx-modal-opts">
            ${sk?.spec && html`<${Toggle} value=${useSpec} onChange=${setUseSpec} label=${t('Spécialisation « {spec} » (+2)', { spec: sk.spec })} />`}
            <${Toggle} value=${edge} onChange=${(v) => setEdge(v && edgeLeft > 0)} label=${t('Chance : repousser les limites ({n})', { n: edgeLeft })} title=${t('+Chance en dés, règle des 6, sans limite — coûte 1 point')} />
            ${Object.entries(switches).map(([k, ls]) => html`<${Toggle} key=${k} value=${conds.includes(k)} onChange=${(v) => setCond(k, v)}
              label=${t('{switch} ({effects})', { switch: toggleText(k), effects: [...new Set(ls.map((l) => effectText(l.mod)))].join(', ') })} />`)}
          </div>`}
          ${pc && html`<${PoolLine} pc=${pc} />`}
          ${pc?.impossible && html`<p class="small red">${pc.reasonKey ? t(pc.reasonKey, pc.reasonParams) : pc.reason}</p>`}

          ${canAgent && html`<div class="mx-agent-box">
            <div class="mx-agent-head">
              <span class="mx-agent-icon">◈</span>
              <div class="grow"><b>${ag.name}</b> <span class="faint small">${t('agent indice {n}', { n: ag.rating })} · ${ag.loaded ? t('chargé') : t('non chargé')}${ag.damage ? ` · ${ag.damage}/${matrixMonitor(ag.rating)}` : ''}</span></div>
            </div>
            ${ag.loaded
              ? html`<div class="mx-agent-choices">
                  <div class="mx-agent-choice">
                    <${Button} variant="accent" disabled=${busy || !persona.online} onClick=${askAssist}>${t('Faire assister mon agent')}</${Button}>
                    <span class="small muted">${t('Travail d’équipe : il lance {pool} dés{limit} ; chaque succès te donne +1 dé (max {max}), et +1 à ta limite s’il en a au moins un.', { pool: agentPc ? agentPc.pool : '—', limit: agentPc?.limit != null ? ` [${agentPc.limit}]` : '', max: sk?.rating || 0 })}</span>
                  </div>
                  ${(assistRes || pending) && html`<div class="mx-assist">
                    ${assistRes && html`<${DiceFaces} roll=${assistRes.roll} small />`}
                    ${assistRes ? html`<div class="small">${outcomeTexts(assistRes).join(' ')}</div>` : html`<div class="small">${t('Assistance en attente : {bonus}.', { bonus: assistText(pending) })}</div>`}
                    ${pending && html`<${Toggle} value=${useAssist} onChange=${setUseAssist} label=${t('Utiliser l’assistance ({bonus})', { bonus: assistText(pending) })} />`}
                  </div>`}
                  <div class="mx-agent-choice">
                    <${Button} disabled=${busy || !persona.online || missingTarget || !marksOk || (targetId === 'manual' && !targetName.trim())} onClick=${agentDo}>${t('Laisser mon agent agir')}</${Button}>
                    <span class="small muted">${t('Il fait l’action à ta place avec {pool} dés{limit} (Indice × 2, limites du deck). Son SO s’ajoute au tien.', { pool: agentPc ? agentPc.pool : '—', limit: agentPc?.limit != null ? ` [${agentPc.limit}]` : '' })}</span>
                  </div>
                </div>`
              : html`<div class="small muted">${t('Charge ton agent (panneau Agent du cockpit) pour qu’il t’assiste ou agisse à ta place.')}</div>`}
          </div>`}

          <div class="row spread mx-modal-actions">
            <span class="small faint">${offline ? t('Connecte-toi d’abord à la Matrice.') : linkLockedJackOut ? t('Aucun verrou de lien : déconnexion immédiate.') : ''}</span>
            <div class="row">
              <${Button} variant="ghost" onClick=${onClose}>${t('Annuler')}</${Button}>
              <${Button} variant="primary" disabled=${busy || offline || missingTarget || !marksOk || pc?.impossible || (targetId === 'manual' && !targetName.trim())} onClick=${run}>
                ${action.noTest ? t('Exécuter') : t('Lancer')}${pc && !pc.impossible ? ` ${t('({n} dés)', { n: pc.pool })}` : ''}
              </${Button}>
            </div>
          </div>`}
    </div>
  </${Modal}>`;
}

