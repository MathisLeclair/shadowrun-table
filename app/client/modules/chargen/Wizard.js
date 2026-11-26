// Character creation wizard: step rail, live budgets, autosaved server-side draft, submit (player) / create (GM).
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, Button, Select, Field, Panel, confirmAction } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { toast, openSheet } from '../../lib/ui-store.js';
import { STEPS, normalizeDraft, emptyDraft } from '/shared/chargen.js';
import { t, tn, fmtNumber, compare, metatypeLabel } from '../../lib/i18n.js';
import { useRulesCtx, useComputed, produce, StatusBadge, timeAgo, nuyen } from './common.js';
import { StepConcept, StepPriorities, StepMetatype, StepAttributes } from './steps-basics.js';
import { StepMagic } from './steps-magic.js';
import { StepSkills, StepContacts } from './steps-skills.js';
import { StepQualities } from './steps-traits.js';
import { StepGear } from './steps-gear.js';
import DraftSummary from './Summary.js';

const COMPONENTS = {
  concept: StepConcept,
  priorities: StepPriorities,
  metatype: StepMetatype,
  attributes: StepAttributes,
  magic: StepMagic,
  skills: StepSkills,
  qualities: StepQualities,
  gear: StepGear,
  contacts: StepContacts,
};
const SAVE_DELAY = 900;

/** props: { game, draft (server record) | null, onExit() } */
export default function Wizard({ game, draft, onExit }) {
  const isGM = game.me.role === 'gm';
  const rc = useRulesCtx(game);
  const [data, setData] = useState(() => {
    if (draft) return normalizeDraft(draft.data);
    const d = emptyDraft();
    if (!isGM) d.concept.player = game.me.name;
    return d;
  });
  const [draftId, setDraftId] = useState(draft?.id || null);
  const [stepIdx, setStepIdx] = useState(0);
  const [save, setSave] = useState({ state: draft ? 'saved' : 'idle', at: draft?.ts || 0 });
  const [busy, setBusy] = useState(false);
  const { result, issues } = useComputed(data, rc);

  // ---- Autosave (debounced, one request at a time, flushed on exit)
  const st = useRef({ data, draftId, dirty: false, saving: null, timer: null, first: true });
  st.current.data = data;
  const flush = async () => {
    const s = st.current;
    clearTimeout(s.timer);
    s.timer = null;
    if (s.saving) await s.saving.catch(() => null);
    if (!s.dirty) return s.draftId;
    s.dirty = false;
    setSave({ state: 'saving', at: 0 });
    s.saving = send('chargen/saveDraft', { draftId: s.draftId || undefined, data: s.data }, { silent: true })
      .then((res) => {
        s.draftId = res.draftId;
        setDraftId(res.draftId);
        setSave({ state: s.dirty ? 'dirty' : 'saved', at: Date.now() });
        return res.draftId;
      })
      .catch((err) => {
        s.dirty = true;
        setSave({ state: 'error', at: 0, error: err.message });
        throw err;
      })
      .finally(() => {
        s.saving = null;
      });
    return s.saving;
  };
  useEffect(() => {
    const s = st.current;
    if (s.first) {
      s.first = false;
      return;
    }
    s.dirty = true;
    setSave((x) => (x.state === 'saving' ? x : { state: 'dirty', at: 0 }));
    clearTimeout(s.timer);
    s.timer = setTimeout(() => flush().catch(() => null), SAVE_DELAY);
  }, [data]);
  useEffect(() => () => {
    const s = st.current;
    if (s.dirty) {
      clearTimeout(s.timer);
      send('chargen/saveDraft', { draftId: s.draftId || undefined, data: s.data }, { silent: true }).catch(() => null);
    }
  }, []);

  const server = draftId ? (game.chargen?.drafts || []).find((d) => d.id === draftId) : null;
  const closed = !isGM && game.chargen?.settings?.allowPlayers === false;
  const locked = closed || (!isGM && server && (server.status === 'pending' || server.status === 'approved'));
  const update = (fn) => {
    if (locked) return;
    setData((d) => produce(d, fn));
  };

  const step = STEPS[stepIdx];
  const go = (i) => {
    setStepIdx(Math.max(0, Math.min(STEPS.length - 1, i)));
    document.querySelector('.cg-main')?.scrollTo?.(0, 0);
  };
  const jump = (id) => go(STEPS.findIndex((s) => s.id === id));

  const exit = async () => {
    try {
      await flush();
    } catch {
      if (!(await confirmAction(t('Le brouillon n’a pas pu être enregistré. Quitter quand même ?')))) return;
    }
    onExit();
  };

  const submit = async () => {
    setBusy(true);
    try {
      const id = await flush();
      await send('chargen/submit', { draftId: id || st.current.draftId });
      toast(t('Personnage envoyé au MJ pour validation'), 'success');
      onExit();
    } catch {
      /* toasted */
    }
    setBusy(false);
  };

  const Comp = COMPONENTS[step.id];
  const r = result;
  const stepState = (id) => (issues[id]?.errors.length ? 'err' : issues[id]?.warnings.length ? 'warn' : 'ok');
  const name = (data.concept.alias || data.concept.name || '').trim() || t('Nouveau personnage');

  return html`<div class="cg-wizard">
    <aside class="cg-rail">
      <div class="cg-rail-head">
        <div class="cg-rail-name" title=${name}>${name}</div>
        <div class="small muted">${metatypeLabel(data.metatype)}${server ? html` · <${StatusBadge} status=${server.status} />` : ''}</div>
      </div>
      <nav class="cg-steps">
        ${STEPS.map((s, i) => html`<button key=${s.id} class=${'cg-stepbtn' + (i === stepIdx ? ' active' : '') + ' ' + stepState(s.id)} onClick=${() => go(i)}>
          <span class="cg-stepnum">${i + 1}</span><span class="grow">${t(s.label)}</span>
          <span class="cg-stepdot" title=${stepState(s.id) === 'err' ? t('Erreurs') : stepState(s.id) === 'warn' ? t('Remarques') : t('OK')}></span>
        </button>`)}
      </nav>
      <div class=${'cg-save ' + save.state} title=${save.error || ''}>
        ${save.state === 'saving' ? t('Enregistrement…') : save.state === 'dirty' ? t('Modifications en cours…') : save.state === 'error' ? t('Échec de l’enregistrement — nouvel essai à la prochaine modification') : save.state === 'saved' ? t('Brouillon enregistré {when}', { when: timeAgo(save.at) }) : t('Pas encore enregistré')}
      </div>
      <${Button} variant="ghost" onClick=${exit}>← ${t('Retour à la liste')}</${Button}>
    </aside>

    <main class="cg-main">
      <header class="cg-head">
        <div class="row wrap spread">
          <h2>${stepIdx + 1}. ${t(step.label)}</h2>
          <div class="cg-head-pills">
            <span class=${'cg-pill ' + pillState(r.spent.attrPoints, r.budgets.attrPoints)} title=${t('Points d’attributs')}>${t('Attr {used}/{total}', { used: r.spent.attrPoints, total: r.budgets.attrPoints })}</span>
            <span class=${'cg-pill ' + pillState(r.spent.specialPoints, r.budgets.specialPoints)} title=${t('Points d’attributs spéciaux')}>${t('Spé {used}/{total}', { used: r.spent.specialPoints, total: r.budgets.specialPoints })}</span>
            <span class=${'cg-pill ' + pillState(r.spent.skillPoints, r.budgets.skillPoints)} title=${t('Points de compétences')}>${t('Comp {used}/{total}', { used: r.spent.skillPoints, total: r.budgets.skillPoints })}</span>
            <span class=${'cg-pill ' + pillState(r.spent.groupPoints, r.budgets.groupPoints)} title=${t('Points de groupes')}>${t('Grp {used}/{total}', { used: r.spent.groupPoints, total: r.budgets.groupPoints })}</span>
            <span class=${'cg-pill ' + (r.karma.left < 0 ? 'over' : 'left')} title=${t('Karma restant')}>${r.karma.left} K</span>
            <span class=${'cg-pill ' + (r.nuyen.left < 0 ? 'over' : 'left')} title=${t('Nuyens restants')}>${nuyen(r.nuyen.left)}</span>
            <span class=${'cg-pill ' + (r.essence <= 0 ? 'over' : 'ok')} title=${t('Essence')}>${t('Ess {n}', { n: fmtNumber(r.essence) })}</span>
            <span class=${'cg-pill ' + (r.errors.length ? 'over' : 'ok')} title=${t('Erreurs de validation')}>${r.errors.length ? tn(r.errors.length, '{n} erreur', '{n} erreurs') : `✓ ${t('valide')}`}</span>
          </div>
        </div>
      </header>
      ${locked && html`<div class="cg-note warn">${closed ? t('Le MJ a fermé la création de personnage : ce brouillon est en lecture seule pour l’instant.') : server.status === 'pending' ? t('Ce personnage attend la validation du MJ : retire la demande depuis la liste pour le modifier.') : t('Ce personnage a été validé : il est en lecture seule.')}</div>`}
      ${server?.status === 'rejected' && server.gmNote && html`<div class="cg-note err"><strong>${t('Le MJ demande des changements :')}</strong> ${server.gmNote}</div>`}
      ${!rc.ready && step.id !== 'concept' && step.id !== 'priorities' && html`<div class="cg-loading small">${t('Chargement des catalogues…')}</div>`}

      <div class=${locked ? 'cg-locked' : ''}>
        ${step.id === 'summary'
          ? html`<${SummaryStep} game=${game} data=${data} result=${r} rc=${rc} onJump=${jump} isGM=${isGM} busy=${busy || locked} submit=${submit} flush=${flush} onExit=${onExit} draftId=${draftId} ownerId=${server && server.userId !== 'gm' ? server.userId : ''} />`
          : html`<${Comp} data=${data} update=${update} result=${r} issues=${issues[step.id]} rc=${rc} game=${game} isGM=${isGM} />`}
      </div>

      <footer class="cg-foot">
        <${Button} variant="ghost" disabled=${stepIdx === 0} onClick=${() => go(stepIdx - 1)}>← ${stepIdx > 0 ? t(STEPS[stepIdx - 1].label) : t('Précédent')}</${Button}>
        <span class="grow"></span>
        ${stepIdx < STEPS.length - 1 && html`<${Button} variant="primary" onClick=${() => go(stepIdx + 1)}>${t(STEPS[stepIdx + 1].label)} →</${Button}>`}
      </footer>
    </main>
  </div>`;
}

function pillState(used, total) {
  return used > total ? 'over' : used === total ? 'ok' : 'left';
}

function SummaryStep({ game, data, result, rc, onJump, isGM, busy, submit, flush, onExit, draftId, ownerId }) {
  return html`<div class="cg-step">
    ${isGM ? html`<${GmCreateBox} game=${game} result=${result} flush=${flush} onExit=${onExit} draftId=${draftId} data=${data} ownerId=${ownerId} />` : html`<div class="cg-submit">
      <div class="grow">
        <strong>${t('Prêt ?')}</strong>
        <div class="small muted">${result.ok ? t('Le MJ va relire ton personnage. Tu pourras encore le modifier s’il demande des changements.') : t('Corrige les erreurs signalées avant d’envoyer ton personnage.')}</div>
      </div>
      <${Button} variant="accent" disabled=${busy || !result.ok || !rc.ready} onClick=${submit}>${t('Envoyer au MJ')} ✉</${Button}>
    </div>`}
    ${!rc.ready ? html`<div class="cg-loading">${t('Chargement des catalogues…')}</div>` : html`<${DraftSummary} data=${data} result=${result} rc=${rc} onJump=${onJump} />`}
  </div>`;
}

function GmCreateBox({ game, result, flush, onExit, draftId, data, ownerId }) {
  const [type, setType] = useState('pc');
  const [assignTo, setAssignTo] = useState(ownerId || '');
  const [busy, setBusy] = useState(false);
  const players = Object.values(game.users || {}).sort((a, b) => compare(a.name, b.name));
  const create = async () => {
    if (!result.ok && !(await confirmAction(tn(result.errors.length, 'one::Ce personnage a {n} erreur(s) de création. Le créer quand même ?', 'Ce personnage a {n} erreur(s) de création. Le créer quand même ?')))) return;
    setBusy(true);
    try {
      let id = draftId;
      try {
        id = await flush();
      } catch {}
      const res = await send('chargen/create', { draftId: id || undefined, data: id ? undefined : data, type, assignTo: type === 'pc' && assignTo ? assignTo : undefined, force: !result.ok });
      toast(type === 'pc' ? t('Personnage joueur créé') : t('PNJ créé'), 'success');
      openSheet(res.actorId);
      onExit();
    } catch {
      /* toasted */
    }
    setBusy(false);
  };
  return html`<${Panel} title=${t('Créer directement (MJ)')} class="cg-mb">
    <div class="row wrap cg-gm-create">
      <${Field} label=${t('Type')}><${Select} value=${type} onChange=${setType} options=${[{ value: 'pc', label: t('Personnage joueur') }, { value: 'npc', label: t('PNJ') }]} /></${Field}>
      ${type === 'pc' && html`<${Field} label=${t('Attribuer à')}><${Select} value=${assignTo} onChange=${setAssignTo} options=${[{ value: '', label: t('— Personne pour l’instant —') }, ...players.map((u) => ({ value: u.id, label: u.name }))]} /></${Field}>`}
      <span class="grow"></span>
      <${Button} variant="primary" disabled=${busy} onClick=${create}>${result.ok ? t('Créer le personnage') : t('Créer malgré les erreurs')}</${Button}>
    </div>
    <div class="small muted">${type === 'pc' ? t('Pas de validation : la fiche est créée tout de suite et attribuée au joueur choisi. Les nuyens de départ sont lancés si l’option est cochée.') : t('Pas de validation : la fiche est créée tout de suite. Les nuyens de départ sont lancés si l’option est cochée.')}</div>
  </${Panel}>`;
}

