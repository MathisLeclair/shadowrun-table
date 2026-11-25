// Roll dialog: pool breakdown, modifiers, wounds, limit, Push the Limit (Chance), GM secret → 'dice/roll'.
// Usable by any module: <RollDialog game actor preset onClose /> where preset =
//   { label?, skillId?, attr?, attr2?, pool?, limit? (number|null), bonus?: [{label, value}], applyWounds? (default true) }
import { useState } from 'preact/hooks';
import { html, Button, NumberInput, Toggle } from '../../lib/ui.js';
import { send } from '../../lib/net.js';
import { derive, attr, skillPool, SKILL_BY_ID, ATTR_SHORT, ATTR_LABELS, skillDefaultLimit } from '/shared/sr5.js';
import { Overlay, DiceFaces, RollBadges, isGM, ownsActor } from './common.js';
import { knowledgeAttr } from './sheet-data.js';

const LIMIT_FR = { physical: 'physique', mental: 'mentale', social: 'sociale', astral: 'astrale' };

/** Client-side preview of the server pool computation (the server stays authoritative). */
export function previewPool(actor, preset, { useSpec } = {}) {
  const parts = [];
  let pool = 0;
  let defaultLimit = null;
  let spec = '';
  let impossible = false;
  if (actor && preset.skillId) {
    const sk = (actor.skills || []).find((s) => s.id === preset.skillId || s.name === preset.skillId);
    const kno = !sk && (actor.knowledge || []).find((k) => k.id === preset.skillId);
    if (kno) {
      const at = preset.attr || knowledgeAttr(kno.type);
      pool = (Number(kno.rating) || 0) + attr(actor, at);
      parts.push([kno.name, kno.rating || 0], [ATTR_SHORT[at], attr(actor, at)]);
      spec = kno.spec || '';
      if (useSpec && kno.spec) {
        pool += 2;
        parts.push([`spé. ${kno.spec}`, 2]);
      }
      defaultLimit = 'mental';
    } else {
      const def = SKILL_BY_ID[preset.skillId];
      const at = preset.attr || sk?.attr || def?.attr || 'AGI';
      const r = skillPool(actor, preset.skillId, { useSpec, attrOverride: preset.attr || undefined });
      impossible = !!r.impossible;
      pool = r.pool;
      spec = sk?.spec || '';
      if (r.defaulting) parts.push([ATTR_SHORT[at], attr(actor, at)], ['par défaut', -1]);
      else {
        parts.push([sk?.name || def?.fr, sk.rating], [ATTR_SHORT[at], attr(actor, at)]);
        if (useSpec && sk.spec) parts.push([`spé. ${sk.spec}`, 2]);
      }
      defaultLimit = skillDefaultLimit(def, at);
    }
  } else if (actor && preset.attr) {
    pool = attr(actor, preset.attr);
    parts.push([ATTR_SHORT[preset.attr], pool]);
    if (preset.attr2) {
      pool += attr(actor, preset.attr2);
      parts.push([ATTR_SHORT[preset.attr2], attr(actor, preset.attr2)]);
    }
  } else {
    pool = Math.max(0, Number(preset.pool) || 0);
    parts.push(['dés', pool]);
  }
  for (const b of preset.bonus || []) {
    if (!b.value) continue;
    pool += b.value;
    parts.push([b.label, b.value]);
  }
  return { pool, parts, defaultLimit, spec, impossible };
}

export function presetLabel(actor, preset) {
  if (preset.label) return preset.label;
  if (preset.skillId) {
    const sk = (actor?.skills || []).find((s) => s.id === preset.skillId);
    const kno = (actor?.knowledge || []).find((k) => k.id === preset.skillId);
    return sk?.name || kno?.name || SKILL_BY_ID[preset.skillId]?.fr || preset.skillId;
  }
  if (preset.attr) return preset.attr2 ? `${ATTR_LABELS[preset.attr]} + ${ATTR_LABELS[preset.attr2]}` : ATTR_LABELS[preset.attr];
  return 'Jet de dés';
}

export function RollDialog({ game, actor, preset = {}, onClose }) {
  const gm = isGM(game);
  const d = actor && !actor.status ? derive(actor) : null;
  const [useSpec, setUseSpec] = useState(!!preset.useSpec);
  const [modifier, setModifier] = useState(0);
  const [wounds, setWounds] = useState(preset.applyWounds !== false && !!d && d.woundModifier < 0);
  const prev = previewPool(actor, preset, { useSpec });
  const autoLimit = preset.limit !== undefined ? preset.limit : prev.defaultLimit && d ? d.limits[prev.defaultLimit] : null;
  const [noLimit, setNoLimit] = useState(autoLimit === null || autoLimit === undefined);
  const [limit, setLimit] = useState(autoLimit || 1);
  const [explode, setExplode] = useState(false);
  const [secret, setSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const live = actor ? game.actors[actor.id] || actor : null;
  const edgeLeft = live?.edge?.current ?? 0;
  const edgeMax = live && live.attributes ? attr(live, 'EDG') : 0;
  const woundMod = wounds && d ? d.woundModifier : 0;
  const total = Math.max(0, prev.pool + modifier + woundMod + (explode ? edgeMax : 0));
  const label = presetLabel(actor, preset);
  const canEdge = !!live && ownsActor(game, live.id) && edgeLeft > 0 && !!live.attributes;

  const roll = async () => {
    setBusy(true);
    try {
      const payload = {
        label, actorId: actor?.id, skillId: preset.skillId, attr: preset.attr, attr2: preset.attr2, useSpec,
        modifier, applyWounds: wounds, explode, secret: gm && secret, bonus: preset.bonus,
        limit: explode || noLimit ? null : limit,
      };
      if (!preset.skillId && !preset.attr) payload.pool = prev.pool;
      const r = await send('dice/roll', payload);
      setResult(r);
      if (explode) setExplode(false);
    } catch {
      /* toast already shown */
    } finally {
      setBusy(false);
    }
  };
  const secondChance = async () => {
    try {
      const r = await send('dice/secondChance', { logId: result.logId });
      setResult({ ...result, ...r });
    } catch {}
  };

  return html`<${Overlay} title=${'Jet — ' + label} onClose=${onClose} width=${480}>
    <div class="sh-rd">
      ${actor && html`<div class="muted small">${actor.name}</div>`}
      <div class="sh-rd-breakdown">
        ${prev.parts.map(([l, v], i) => html`<span class=${'sh-rd-part' + (v < 0 ? ' bad' : '')}><span>${l}</span><b>${i > 0 && v >= 0 ? '+' : ''}${v}</b></span>`)}
        ${modifier ? html`<span class="sh-rd-part"><span>mod.</span><b>${modifier > 0 ? '+' : ''}${modifier}</b></span>` : null}
        ${woundMod ? html`<span class="sh-rd-part bad"><span>blessures</span><b>${woundMod}</b></span>` : null}
        ${explode ? html`<span class="sh-rd-part edge"><span>Chance</span><b>+${edgeMax}</b></span>` : null}
        <span class="sh-rd-total">= ${total} dé${total > 1 ? 's' : ''}</span>
      </div>
      ${prev.impossible && html`<div class="error small">Compétence non maîtrisée : impossible de l’utiliser par défaut.</div>`}

      <div class="sh-rd-grid">
        <div class="field"><span class="field-label">Modificateur</span><${NumberInput} value=${modifier} min=${-30} max=${30} onChange=${setModifier} /></div>
        <div class="field"><span class="field-label">Limite</span>
          <div class="row">
            ${!explode && !noLimit ? html`<${NumberInput} value=${limit} min=${1} max=${30} onChange=${setLimit} small />` : html`<span class="muted small">${explode ? 'aucune (Chance)' : 'aucune'}</span>`}
            ${!explode && html`<${Toggle} value=${!noLimit} onChange=${(v) => setNoLimit(!v)} title="Appliquer une limite" />`}
          </div>
          ${prev.defaultLimit && !explode && html`<span class="field-hint">Limite ${LIMIT_FR[prev.defaultLimit]} : ${d?.limits?.[prev.defaultLimit] ?? '—'}</span>`}
        </div>
      </div>
      <div class="col gap-s">
        ${prev.spec && html`<${Toggle} value=${useSpec} onChange=${setUseSpec} label=${`Spécialisation (${prev.spec}) +2`} />`}
        ${d && d.woundModifier < 0 && html`<${Toggle} value=${wounds} onChange=${setWounds} label=${`Malus de blessures (${d.woundModifier})`} />`}
        ${canEdge && html`<${Toggle} value=${explode} onChange=${setExplode} label=${`Repousser les limites (+${edgeMax} dés, règle des 6) — Chance ${edgeLeft}/${edgeMax}`} />`}
        ${gm && html`<${Toggle} value=${secret} onChange=${setSecret} label="Jet secret (visible du MJ seulement)" />`}
      </div>

      ${result && html`<div class="sh-rd-result">
        <div class="sh-rd-hits"><b>${result.hits}</b><span>succès</span></div>
        <div class="grow col gap-s">
          <${DiceFaces} roll=${result} />
          <${RollBadges} roll=${result} />
        </div>
      </div>`}

      <div class="row spread wrap">
        <div class="row">
          ${result && !result.explode && !result.secondChance && canEdge && html`<${Button} small variant="accent" onClick=${secondChance} title="Relancer tous les dés qui ne sont pas des succès (1 point de Chance)">Seconde chance</${Button}>`}
        </div>
        <div class="row">
          <${Button} variant="ghost" onClick=${onClose}>Fermer</${Button}>
          <${Button} variant="primary" disabled=${busy || total <= 0 || prev.impossible} onClick=${roll}>${result ? 'Relancer' : 'Lancer'} ${total} dé${total > 1 ? 's' : ''}</${Button}>
        </div>
      </div>
    </div>
  </${Overlay}>`;
}

export default RollDialog;
