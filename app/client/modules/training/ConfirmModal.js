// Summary card shown before sending a training request: target rating, karma before/after, time,
// instructor option, warnings, and how the request will be validated.
import { useState } from 'preact/hooks';
import { html, Modal, Button, Field, NumberInput, TextInput, Toggle, Badge } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { toast } from '../../lib/ui-store.js';
import { RULE_TEXT, KIND_LABELS, formatDays, magicProfile, powerPoints, withInstructor } from '/shared/advancement.js';
import { nuyen } from '/shared/util.js';
import { settingsOf, makeQuoter, quoteContext } from './common.js';

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
  if (isGM) approvalText = qt.days > 0 ? 'Validé directement (MJ) : l’entraînement démarre maintenant.' : 'Validé directement (MJ) : effet immédiat.';
  else if (settings.approval === 'always' || manual) approvalText = `${manual ? 'Saisie manuelle : ' : ''}le MJ doit valider ta demande. Le karma n’est débité qu’à la validation.`;
  else approvalText = qt.days > 0 ? 'Validation automatique : l’entraînement démarre dès l’envoi.' : 'Validation automatique : effet immédiat.';

  const submit = async () => {
    if (qt.error || busy) return;
    setBusy(true);
    try {
      const res = await send('training/request', { ...effective, actorId: actor.id });
      const msg = res?.status === 'pending' ? 'Demande envoyée au MJ' : res?.status === 'done' ? 'Progression acquise !' : 'Entraînement commencé';
      toast(msg, 'success');
      onClose();
    } catch {
      setBusy(false);
    }
  };

  const toValue = req.to ?? qt.to;
  return html`<${Modal} title=${KIND_LABELS[req.kind] || 'Progression'} width=${560} onClose=${onClose}>
    <div class="training-confirm col gap-l">
      <div>
        <div class="training-confirm-label">${qt.label}</div>
        <div class="small muted">${actor.name} · ${RULE_TEXT[req.kind] || ''}</div>
      </div>

      <div class="training-confirm-fields">
        ${multi &&
        html`<${Field} label=${req.kind === 'power' ? 'Niveau visé' : 'Rang visé'} hint=${`Actuel : ${qt.from}`}>
          <${NumberInput} value=${toValue} min=${qt.from + 1} max=${MAX_TO[req.kind] || 12} onChange=${(n) => set({ to: n })} />
        </${Field}>`}
        ${(req.kind === 'skill' || req.kind === 'knowledge') &&
        html`<${Field} label="Spécialisation (optionnel)" hint="+7 karma · +1 mois">
          <${TextInput} live value=${req.spec || ''} placeholder="ex. Ares Predator" onChange=${(v) => set({ spec: v })} />
        </${Field}>`}
        ${req.kind === 'specialization' &&
        html`<${Field} label="Spécialisation">
          <${TextInput} live value=${req.spec || ''} placeholder="ex. Katana, Corpos, Drones…" onChange=${(v) => set({ spec: v })} autofocus />
        </${Field}>`}
        ${req.kind === 'power' &&
        !req.catalogId &&
        html`<${Field} label="Coût (PP par niveau)">
          <${NumberInput} value=${req.pp || 0} min=${0} max=${10} step=${0.25} onChange=${(n) => set({ pp: n })} />
        </${Field}>`}
        ${req.kind === 'power' &&
        !draft.existing &&
        html`<${Field} label="Précision (optionnel)" hint="ex. Capacité améliorée (Pistolets)">
          <${TextInput} live value=${precision} placeholder="Compétence, sens…" onChange=${setPrecision} />
        </${Field}>`}
        ${req.kind === 'initiation' &&
        html`<div class="col">
          <span class="field-label">Options (−10 % chacune)</span>
          <${Toggle} label="Initiation de groupe" value=${req.options?.group} onChange=${(v) => set({ options: { ...req.options, group: v } })} />
          <${Toggle} label="Ordalie" value=${req.options?.ordeal} onChange=${(v) => set({ options: { ...req.options, ordeal: v } })} />
          <${Toggle} label="École / enseignement" value=${req.options?.schooling} onChange=${(v) => set({ options: { ...req.options, schooling: v } })} />
          <${Field} label=${prof.MAG > 0 ? 'Métamagie apprise (optionnel)' : 'Écho appris (optionnel)'}>
            <${TextInput} live value=${req.options?.metamagic || ''} placeholder=${prof.MAG > 0 ? 'ex. Centrage, Masquage…' : 'ex. Neuro-filtre…'} onChange=${(v) => set({ options: { ...req.options, metamagic: v } })} />
          </${Field}>
          ${prof.hasPowers && html`<${Toggle} label="Gagner un point de pouvoir" value=${req.options?.powerPoint} onChange=${(v) => set({ options: { ...req.options, powerPoint: v } })} />`}
        </div>`}
      </div>

      ${canInstructor &&
      html`<div class="training-instructor">
        <${Toggle} label="Avec instructeur" value=${!!req.instructor} onChange=${(v) => set({ instructor: v })} title=${RULE_TEXT.instructor} />
        <div class="small muted">
          Seul : ${formatDays(soloDays)} · Avec instructeur : ${formatDays(insPreview.days)} pour ${nuyen(insPreview.nuyen)}
          <span class="faint"> (${nuyen(insPreview.rate)}/semaine, −${settings.instructorTimeReduction} %)</span>
        </div>
      </div>`}

      <div class="training-summary">
        <div class="training-sum-row">
          <span>Karma</span>
          <span class="mono">${karmaAvail} → <strong class=${karmaAvail - qt.karmaCost < 0 ? 'red' : 'cyan'}>${karmaAvail - qt.karmaCost}</strong> <span class="muted">(−${qt.karmaCost})</span></span>
        </div>
        <div class="training-sum-row">
          <span>Durée</span>
          <span>${formatDays(qt.days)}${qt.instructor && soloDays !== qt.days ? html` <s class="faint">${formatDays(soloDays)}</s>` : ''}${!settings.useTime ? html` <span class="faint small">(temps d’entraînement désactivé)</span>` : ''}</span>
        </div>
        ${qt.nuyenCost > 0 &&
        html`<div class="training-sum-row">
          <span>Instructeur</span>
          <span class="mono">${nuyen(nuyenAvail)} → <strong class="magenta">${nuyen(nuyenAvail - qt.nuyenCost)}</strong></span>
        </div>`}
        ${pp &&
        html`<div class="training-sum-row">
          <span>Points de pouvoir</span>
          <span class="mono">${pp.free} libres → <strong class="cyan">${Math.round((pp.free - (qt.ppCost || 0)) * 100) / 100}</strong></span>
        </div>`}
      </div>

      ${qt.warnings.map((w) => html`<div class="training-warn small">⚠ ${w}</div>`)}
      ${qt.error && html`<div class="error small">${qt.error}</div>`}

      ${isGM &&
      html`<${Toggle} label="Offert par le MJ (sans karma ni nuyens)" value=${!!req.free} onChange=${(v) => set({ free: v })} />`}
      <${Field} label=${isGM ? 'Note (historique)' : 'Note pour le MJ (optionnel)'}>
        <${TextInput} live value=${req.note || ''} placeholder=${isGM ? '' : 'ex. Cours avec Perrine, salle de sport du quartier…'} onChange=${(v) => set({ note: v })} />
      </${Field}>

      <div class="row spread wrap">
        <span class="small muted grow">${manual && !isGM ? html`<${Badge} color="magenta">manuel</${Badge}> ` : ''}${approvalText}</span>
        <span class="row">
          <${Button} variant="ghost" onClick=${onClose}>Annuler</${Button}>
          <${Button} variant="primary" disabled=${!!qt.error || busy} onClick=${submit}>${isGM ? 'Appliquer' : settings.approval === 'always' || manual ? 'Envoyer la demande' : 'Valider'}</${Button}>
        </span>
      </div>
    </div>
  </${Modal}>`;
}
