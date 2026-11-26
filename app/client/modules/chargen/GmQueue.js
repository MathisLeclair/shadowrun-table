// GM side of character creation: approval queue with full review, every draft, settings.
import { useMemo, useState } from 'preact/hooks';
import { html, Button, Panel, Empty, Badge, Tabs, TextInput, Toggle, NumberInput, Field, confirmAction } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { toast, openSheet } from '../../lib/ui-store.js';
import { draftHeadline, normalizeDraft } from '/shared/chargen.js';
import { t, tn } from '../../lib/i18n.js';
import { useRulesCtx, useComputed, StatusBadge, timeAgo, headlineText, ownerName } from './common.js';
import DraftSummary from './Summary.js';

function DraftCard({ d, active, onClick, game }) {
  const h = draftHeadline(d.data);
  const ht = headlineText(h);
  const owner = ownerName(game, d);
  return html`<div class=${'cg-dcard card clickable' + (active ? ' active' : '')} onClick=${onClick}>
    <div class="cg-dcard-portrait" style=${d.data?.concept?.portrait ? { backgroundImage: `url("${String(d.data.concept.portrait).replace(/"/g, '%22')}")` } : {}}>${d.data?.concept?.portrait ? '' : ht.name.slice(0, 2).toUpperCase()}</div>
    <div class="grow">
      <div class="spread row"><strong>${ht.name}</strong><span class="mono small faint" title=${t('Métatype / Attributs / Magie / Compétences / Ressources')}>${h.letters}</span></div>
      <div class="small muted">${ht.text || '—'}</div>
      <div class="row wrap gap-s cg-dcard-meta">
        <${StatusBadge} status=${d.status} />
        <span class="small faint">${owner} · ${timeAgo(d.submittedTs && d.status === 'pending' ? d.submittedTs : d.ts)}</span>
        ${d.check?.errors > 0 && html`<${Badge} color="red">${tn(d.check.errors, '{n} erreur', '{n} erreurs')}</${Badge}>`}
      </div>
    </div>
  </div>`;
}

function Review({ game, d, rc, onDone, onEdit }) {
  const data = useMemo(() => normalizeDraft(d.data), [d.data]);
  const { result } = useComputed(data, rc);
  const [note, setNote] = useState(d.gmNote || '');
  const [busy, setBusy] = useState(false);
  const owner = d.userId === 'gm' ? null : game.users?.[d.userId];
  const resolve = async (approve) => {
    if (approve && !result.ok && !(await confirmAction(tn(result.errors.length, 'one::{n} erreur(s) de création. Valider quand même ce personnage ?', '{n} erreur(s) de création. Valider quand même ce personnage ?')))) return;
    if (!approve && !note.trim() && !(await confirmAction(t('Renvoyer sans expliquer ce qu’il faut changer ?')))) return;
    setBusy(true);
    try {
      const res = await send('chargen/resolve', { draftId: d.id, approve, note, force: approve && !result.ok });
      toast(approve ? t('Personnage validé et attribué') : t('Personnage renvoyé au joueur'), approve ? 'success' : 'info');
      if (approve && res.actorId) openSheet(res.actorId);
      onDone();
    } catch {
      /* toasted */
    }
    setBusy(false);
  };
  return html`<div class="col">
    ${d.status === 'pending' && html`<${Panel} title=${t('Décision — {name}', { name: owner ? owner.name : t('MJ') })}>
      <div class="col">
        <${Field} label=${t('Note au joueur (facultatif pour une validation)')}>
          <${TextInput} live multiline rows=${2} value=${note} placeholder=${t('ex. Remplace Allergie (commune) par une allergie plus rare.')} onChange=${setNote} />
        </${Field}>
        <div class="row wrap">
          <${Button} variant="primary" disabled=${busy} onClick=${() => resolve(true)}>${result.ok ? `✓ ${t('Valider et créer la fiche')}` : `✓ ${t('Valider malgré les erreurs')}`}</${Button}>
          <${Button} variant="danger" disabled=${busy} onClick=${() => resolve(false)}>↺ ${t('Demander des changements')}</${Button}>
          <span class="grow"></span>
          <${Button} variant="ghost" onClick=${onEdit}>${t('Ouvrir dans l’assistant')}</${Button}>
        </div>
        <div class="small muted">${owner ? t('La validation crée la fiche (nuyens de départ lancés si demandé) et la donne à {name}.', { name: owner.name }) : t('La validation crée la fiche (nuyens de départ lancés si demandé) et la donne à personne.')}</div>
      </div>
    </${Panel}>`}
    ${d.status === 'approved' && d.actorId && html`<div class="cg-note ok">${t('Validé {when}.', { when: timeAgo(d.resolvedTs) })} ${game.actors?.[d.actorId] ? html`<button class="cg-link" onClick=${() => openSheet(d.actorId)}>${t('Ouvrir la fiche')} →</button>` : t('La fiche a été supprimée depuis.')}</div>`}
    ${d.status === 'rejected' && html`<div class="cg-note err">${d.gmNote ? t('Renvoyé {when} : « {note} »', { when: timeAgo(d.resolvedTs), note: d.gmNote }) : t('Renvoyé {when}', { when: timeAgo(d.resolvedTs) })}</div>`}
    ${!rc.ready ? html`<div class="cg-loading">${t('Chargement des catalogues…')}</div>` : html`<${DraftSummary} data=${data} result=${result} rc=${rc} />`}
  </div>`;
}

/** props: { game, onOpenWizard(draft|null) } */
export default function GmQueue({ game, onOpenWizard }) {
  const rc = useRulesCtx(game);
  const drafts = game.chargen?.drafts || [];
  const settings = game.chargen?.settings || {};
  const pending = drafts.filter((d) => d.status === 'pending').sort((a, b) => (a.submittedTs || 0) - (b.submittedTs || 0));
  const others = drafts.filter((d) => d.status !== 'pending').sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const [tab, setTab] = useState(pending.length ? 'queue' : 'all');
  const [selId, setSelId] = useState(null);
  const list = tab === 'queue' ? pending : others;
  const sel = list.find((d) => d.id === selId) || (tab === 'queue' ? pending[0] : null);

  const remove = async (d) => {
    const name = headlineText(draftHeadline(d.data)).name;
    const question = d.status === 'approved'
      ? t('Supprimer le brouillon « {name} » ?\n(La fiche déjà créée n’est pas touchée.)', { name })
      : t('Supprimer le brouillon « {name} » ?', { name });
    if (!(await confirmAction(question))) return;
    send('chargen/delete', { draftId: d.id }).then(() => setSelId(null)).catch(() => null);
  };

  return html`<div class="cg-gm">
    <div class="row wrap spread cg-gm-bar">
      <${Tabs} tabs=${[
        { id: 'queue', label: t('À valider'), badge: pending.length || null },
        { id: 'all', label: t('Brouillons & historique ({n})', { n: others.length }) },
        { id: 'settings', label: t('Réglages') },
      ]} value=${tab} onChange=${(x) => (setTab(x), setSelId(null))} />
      <${Button} variant="primary" onClick=${() => onOpenWizard(null)}>✚ ${t('Créer un personnage (MJ)')}</${Button}>
    </div>

    ${tab === 'settings'
      ? html`<${Panel} title=${t('Création de personnage')}>
          <div class="col">
            <${Toggle} value=${settings.allowPlayers !== false} onChange=${(v) => send('chargen/settings', { allowPlayers: v }).catch(() => null)} label=${t('Les joueurs peuvent créer et soumettre des personnages')} />
            <${Field} label=${t('Karma de départ supplémentaire')} hint=${t('Ajouté aux 25 karma de création (campagne plus ou moins héroïque)')}>
              <${NumberInput} value=${settings.startingKarmaBonus || 0} min=${-25} max=${100} onChange=${(v) => send('chargen/settings', { startingKarmaBonus: v }).catch(() => null)} />
            </${Field}>
            <div class="small muted">${t('Méthode : priorités (SR5, livre de base p.62). Disponibilité 12 maximum, grades standard / alpha / d’occasion, 7 karma et 5 000¥ conservés au plus.')}</div>
          </div>
        </${Panel}>`
      : html`<div class=${'cg-gm-layout' + (sel ? ' has-sel' : '')}>
          <div class="cg-gm-list">
            ${list.map((d) => html`<${DraftCard} key=${d.id} d=${d} game=${game} active=${sel?.id === d.id} onClick=${() => setSelId(d.id)} />`)}
            ${!list.length && html`<${Empty}>${tab === 'queue' ? t('Aucun personnage en attente de validation.') : t('Aucun brouillon.')}</${Empty}>`}
          </div>
          <div class="cg-gm-detail">
            ${sel
              ? html`<div class="row wrap cg-mb">
                  <${Button} small variant="ghost" class="cg-back" onClick=${() => setSelId(null)}>← ${t('Liste')}</${Button}>
                  <span class="grow"></span>
                  ${sel.status !== 'approved' && html`<${Button} small onClick=${() => onOpenWizard(sel)}>${t('Ouvrir dans l’assistant')}</${Button}>`}
                  <${Button} small variant="danger" onClick=${() => remove(sel)}>${t('Supprimer')}</${Button}>
                </div>
                <${Review} key=${sel.id} game=${game} d=${sel} rc=${rc} onDone=${() => setSelId(null)} onEdit=${() => onOpenWizard(sel)} />`
              : html`<${Empty}>${tab === 'queue' ? t('Les personnages soumis par les joueurs apparaissent ici.') : t('Choisis un brouillon pour le relire.')}</${Empty}>`}
          </div>
        </div>`}
  </div>`;
}
