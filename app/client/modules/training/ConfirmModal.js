// Summary card shown before sending a training request: target rating, karma before/after, time,
// instructor option, warnings, and how the request will be validated.
import { useState } from 'preact/hooks';
import { html, Modal, Button, Field, NumberInput, TextInput, Toggle, Badge } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { toast } from '../../lib/ui-store.js';
import { t, fmtNuyen } from '../../lib/i18n.js';
import { magicProfile, powerPoints, withInstructor } from '/shared/advancement.js';
import { settingsOf, makeQuoter, quoteContext, kindLabel, ruleText, fmtDays, labelOf, errorOf, warningsOf } from './common.js';

const MULTI = ['attribute', 'skill', 'skillGroup', 'knowledge', 'powerPoint'];
const MAX_TO = { attribute: 12, skill: 13, skillGroup: 12, knowledge: 12, powerPoint: 12, power: 12 };

export default function ConfirmModal({ game, actor, draft, isGM, onClose }) {
  const [req, setReq] = useState(() => ({ ...draft }));
  const [precision, setPrecision] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (patch) => setReq((r) => ({ ...r, ...patch }));

  const settings = settingsOf(game);
  const quoter = makeQuoter(game, actor);
  const effective = req.kind === 'power' && precision.trim() ? { ...req, name: `${req.name} (${precision.trim()})` } : req;
  const qt = quoter(effective);
  const ctx = quoteContext(game, actor);
  const prof = magicProfile(actor);
  const multi = MULTI.includes(req.kind) || (req.kind === 'power' && req.levels);
  const canInstructor = settings.useTime && qt.daysBase > 0;
  const soloDays = qt.daysBase;
  const insPreview = canInstructor ? withInstructor(qt.daysBase, req.kind, settings) : null;
  const manual = req.kind === 'other' || (['quality', 'spell', 'power'].includes(req.kind) && !req.catalogId);
  const karmaAvail = (Number(actor.karma) || 0) - ctx.reservedKarma;
  const nuyenAvail = (Number(actor.nuyen) || 0) - ctx.reservedNuyen;
  const pp = req.kind === 'power' ? powerPoints(actor) : null;

  let approvalText;
  if (isGM) approvalText = qt.days > 0 ? t('Validé directement (MJ) : l’entraînement démarre maintenant.') : t('Validé directement (MJ) : effet immédiat.');
  else if (settings.approval === 'always' || manual) approvalText = manual ? t('Saisie manuelle : le MJ doit valider ta demande. Le karma n’est débité qu’à la validation.') : t('le MJ doit valider ta demande. Le karma n’est débité qu’à la validation.');
  else approvalText = qt.days > 0 ? t('Validation automatique : l’entraînement démarre dès l’envoi.') : t('Validation automatique : effet immédiat.');

  const submit = async () => {
    if (qt.error || busy) return;
    setBusy(true);
    try {
      const res = await send('training/request', { ...effective, actorId: actor.id });
      const msg = res?.status === 'pending' ? t('Demande envoyée au MJ') : res?.status === 'done' ? t('Progression acquise !') : t('Entraînement commencé');
      toast(msg, 'success');
      onClose();
    } catch {
      setBusy(false);
    }
  };

  const toValue = req.to ?? qt.to;
  return html`<${Modal} title=${req.kind ? kindLabel(req.kind) : t('Progression')} width=${560} onClose=${onClose}>
    <div class="training-confirm col gap-l">
      <div>
        <div class="training-confirm-label">${labelOf(qt)}</div>
        <div class="small muted">${actor.name} · ${ruleText(req.kind)}</div>
      </div>

      <div class="training-confirm-fields">
        ${multi &&
        html`<${Field} label=${req.kind === 'power' ? t('Niveau visé') : t('Rang visé')} hint=${t('Actuel : {n}', { n: qt.from })}>
          <${NumberInput} value=${toValue} min=${qt.from + 1} max=${MAX_TO[req.kind] || 12} onChange=${(n) => set({ to: n })} />
        </${Field}>`}
        ${(req.kind === 'skill' || req.kind === 'knowledge') &&
        html`<${Field} label=${t('Spécialisation (optionnel)')} hint=${t('+7 karma · +1 mois')}>
          <${TextInput} live value=${req.spec || ''} placeholder=${t('ex. Ares Predator')} onChange=${(v) => set({ spec: v })} />
        </${Field}>`}
        ${req.kind === 'specialization' &&
        html`<${Field} label=${t('Spécialisation')}>
          <${TextInput} live value=${req.spec || ''} placeholder=${t('ex. Katana, Corpos, Drones…')} onChange=${(v) => set({ spec: v })} autofocus />
        </${Field}>`}
        ${req.kind === 'power' &&
        !req.catalogId &&
        html`<${Field} label=${t('Coût (PP par niveau)')}>
          <${NumberInput} value=${req.pp || 0} min=${0} max=${10} step=${0.25} onChange=${(n) => set({ pp: n })} />
        </${Field}>`}
        ${req.kind === 'power' &&
        !draft.existing &&
        html`<${Field} label=${t('Précision (optionnel)')} hint=${t('ex. Capacité améliorée (Pistolets)')}>
          <${TextInput} live value=${precision} placeholder=${t('Compétence, sens…')} onChange=${setPrecision} />
        </${Field}>`}
        ${req.kind === 'initiation' &&
        html`<div class="col">
          <span class="field-label">${t('Options (−10 % chacune)')}</span>
          <${Toggle} label=${t('Initiation de groupe')} value=${req.options?.group} onChange=${(v) => set({ options: { ...req.options, group: v } })} />
          <${Toggle} label=${t('Ordalie')} value=${req.options?.ordeal} onChange=${(v) => set({ options: { ...req.options, ordeal: v } })} />
          <${Toggle} label=${t('École / enseignement')} value=${req.options?.schooling} onChange=${(v) => set({ options: { ...req.options, schooling: v } })} />
          <${Field} label=${prof.MAG > 0 ? t('Métamagie apprise (optionnel)') : t('Écho appris (optionnel)')}>
            <${TextInput} live value=${req.options?.metamagic || ''} placeholder=${prof.MAG > 0 ? t('ex. Centrage, Masquage…') : t('ex. Neuro-filtre…')} onChange=${(v) => set({ options: { ...req.options, metamagic: v } })} />
          </${Field}>
          ${prof.hasPowers && html`<${Toggle} label=${t('Gagner un point de pouvoir')} value=${req.options?.powerPoint} onChange=${(v) => set({ options: { ...req.options, powerPoint: v } })} />`}
        </div>`}
      </div>

      ${canInstructor &&
      html`<div class="training-instructor">
        <${Toggle} label=${t('Avec instructeur')} value=${!!req.instructor} onChange=${(v) => set({ instructor: v })} title=${ruleText('instructor')} />
        <div class="small muted">
          ${t('Seul : {solo} · Avec instructeur : {days} pour {cost}', { solo: fmtDays(soloDays), days: fmtDays(insPreview.days), cost: fmtNuyen(insPreview.nuyen) })}
          <span class="faint"> ${t('({rate}/semaine, −{pct} %)', { rate: fmtNuyen(insPreview.rate), pct: settings.instructorTimeReduction })}</span>
        </div>
      </div>`}

      <div class="training-summary">
        <div class="training-sum-row">
          <span>${t('Karma')}</span>
          <span class="mono">${karmaAvail} → <strong class=${karmaAvail - qt.karmaCost < 0 ? 'red' : 'cyan'}>${karmaAvail - qt.karmaCost}</strong> <span class="muted">(−${qt.karmaCost})</span></span>
        </div>
        <div class="training-sum-row">
          <span>${t('Durée')}</span>
          <span>${fmtDays(qt.days)}${qt.instructor && soloDays !== qt.days ? html` <s class="faint">${fmtDays(soloDays)}</s>` : ''}${!settings.useTime ? html` <span class="faint small">${t('(temps d’entraînement désactivé)')}</span>` : ''}</span>
        </div>
        ${qt.nuyenCost > 0 &&
        html`<div class="training-sum-row">
          <span>${t('Instructeur')}</span>
          <span class="mono">${fmtNuyen(nuyenAvail)} → <strong class="magenta">${fmtNuyen(nuyenAvail - qt.nuyenCost)}</strong></span>
        </div>`}
        ${pp &&
        html`<div class="training-sum-row">
          <span>${t('Points de pouvoir')}</span>
          <span class="mono">${t('{n} libres', { n: pp.free })} → <strong class="cyan">${Math.round((pp.free - (qt.ppCost || 0)) * 100) / 100}</strong></span>
        </div>`}
      </div>

      ${warningsOf(qt).map((w) => html`<div class="training-warn small">⚠ ${w}</div>`)}
      ${qt.error && html`<div class="error small">${errorOf(qt)}</div>`}

      ${isGM &&
      html`<${Toggle} label=${t('Offert par le MJ (sans karma ni nuyens)')} value=${!!req.free} onChange=${(v) => set({ free: v })} />`}
      <${Field} label=${isGM ? t('Note (historique)') : t('Note pour le MJ (optionnel)')}>
        <${TextInput} live value=${req.note || ''} placeholder=${isGM ? '' : t('ex. Cours avec Perrine, salle de sport du quartier…')} onChange=${(v) => set({ note: v })} />
      </${Field}>

      <div class="row spread wrap">
        <span class="small muted grow">${manual && !isGM ? html`<${Badge} color="magenta">${t('manuel')}</${Badge}> ` : ''}${approvalText}</span>
        <span class="row">
          <${Button} variant="ghost" onClick=${onClose}>${t('Annuler')}</${Button}>
          <${Button} variant="primary" disabled=${!!qt.error || busy} onClick=${submit}>${isGM ? t('Appliquer') : settings.approval === 'always' || manual ? t('Envoyer la demande') : t('Valider')}</${Button}>
        </span>
      </div>
    </div>
  </${Modal}>`;
}
