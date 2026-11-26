// Chummer5a interop UI: import a .chum5 (GM), export a sheet to .chum5, re-import with a diff confirmation,
// GM settings + approval of players' uploads. Server side: server/modules/85-chummer.js.
//   <ChummerImportButton />                — GM, CharactersPage: new actor from a file
//   <ChummerSheetBar game actor />         — sheet header (GM + owning player): export / update / status
//   <ChummerGmPanel game />                — CharactersPage: « autoriser les joueurs… » + pending requests
import { useRef, useState } from 'preact/hooks';
import { html, Button, Badge, Toggle, Empty, loadCss, confirmAction } from '../../lib/ui.js';
import { send, api, getToken } from '../../lib/net.js';
import { openSheet, toast } from '../../lib/ui-store.js';
import { t, tIfKnown, errorText, attrLabel, skillLabel, metatypeLabel, fmtDate } from '../../lib/i18n.js';
import { Overlay } from '../sheet/common.js';

loadCss('/modules/chummer/chummer.css');

const isGM = (game) => game?.me?.role === 'gm';

/** Short date + time ('26/11 14:05' in French). */
function fmtWhen(ts) {
  if (!ts) return '';
  return fmtDate(ts, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Translatable server texts: `i18n` = [{ t, params }] when the server sent keys, else the French strings. */
const texts = (list, i18n) => (Array.isArray(i18n) && i18n.length ? i18n.map((w) => t(w.t, w.params)) : (list || []).map((w) => tIfKnown(String(w ?? ''))));

/** Hidden file input + trigger. onFile(file, text) */
function useFilePicker(onFile) {
  const ref = useRef(null);
  const input = html`<input ref=${ref} type="file" accept=".chum5,.xml,.json" hidden onChange=${async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 20e6) return toast(t('Fichier trop gros (20 Mo max)'), 'error');
    try {
      onFile(file, await file.text());
    } catch (err) {
      toast(err.message || t('Lecture du fichier impossible'), 'error');
    }
  }} />`;
  return [input, () => ref.current?.click()];
}

const postText = (url, text) => api(url, { method: 'POST', body: new Blob([text], { type: 'text/plain' }), headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

const parseHeaderJson = (v) => {
  try {
    return JSON.parse(decodeURIComponent(v || '%5B%5D'));
  } catch {
    return [];
  }
};

/** Download the actor as .chum5. Resolves with the server's warnings (French + translatable copy). */
export async function downloadChum5(actor) {
  const res = await fetch(`/api/chummer/export/${encodeURIComponent(actor.id)}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      if (body?.error || body?.errorKey) msg = errorText(body);
    } catch {}
    throw new Error(msg);
  }
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') || '';
  const star = cd.match(/filename\*=UTF-8''([^;]+)/i);
  const plain = cd.match(/filename="([^"]+)"/i);
  const name = star ? decodeURIComponent(star[1]) : plain ? plain[1] : `${actor.name || 'personnage'}.chum5`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  const warnings = parseHeaderJson(res.headers.get('x-chummer-warnings'));
  const warningsI18n = parseHeaderJson(res.headers.get('x-chummer-warnings-i18n'));
  return { name, warnings, warningsI18n, mode: res.headers.get('x-chummer-mode') || '' };
}

// A whole translated sentence with one part in bold: the sentence is translated with MARK as that part, then split.
const MARK = '\u0001';
function withBold(sentence, bold) {
  const [before, after = ''] = sentence.split(MARK);
  return html`${before}<b>${bold}</b>${after}`;
}

// ---------------------------------------------------------------------------
// Diff view
// ---------------------------------------------------------------------------
// Scalar values the server stores as French words (translated when known); other values are data.
const TRANSLATED_VALUES = new Set(['Description', 'Notes']);
function scalarValue(s, v) {
  const text = String(v);
  if (s.label === 'Métatype') return metatypeLabel(text);
  return TRANSLATED_VALUES.has(s.label) ? tIfKnown(text) : text;
}

export function DiffView({ diff }) {
  if (!diff) return null;
  if (diff.empty) return html`<${Empty}>${t('Aucune différence avec la fiche actuelle.')}</${Empty}>`;
  return html`<div class="chm-diff">
    ${diff.scalars.length > 0 && html`<section>
      <h4 class="chm-diff-h">${t('Général')}</h4>
      <table class="sr chm-diff-table"><tbody>
        ${diff.scalars.map((s) => html`<tr key=${s.label}><td>${tIfKnown(s.label)}</td><td class="chm-from">${scalarValue(s, s.from)}</td><td class="chm-arrow">→</td><td class="chm-to">${scalarValue(s, s.to)}</td></tr>`)}
      </tbody></table>
    </section>`}
    ${diff.attributes.length > 0 && html`<section>
      <h4 class="chm-diff-h">${t('Attributs')}</h4>
      <table class="sr chm-diff-table"><tbody>
        ${diff.attributes.map((s) => html`<tr key=${s.key}><td>${s.key ? attrLabel(s.key) : s.label}</td><td class="chm-from">${s.from}</td><td class="chm-arrow">→</td><td class="chm-to">${s.to}</td></tr>`)}
      </tbody></table>
    </section>`}
    ${diff.skills.length > 0 && html`<section>
      <h4 class="chm-diff-h">${t('Compétences')}</h4>
      <table class="sr chm-diff-table"><tbody>
        ${diff.skills.map((s) => html`<tr key=${s.id}><td>${skillLabel({ id: s.id, name: s.name })}</td><td class="chm-from">${s.from}</td><td class="chm-arrow">→</td><td class="chm-to">${s.to}</td></tr>`)}
      </tbody></table>
    </section>`}
    ${diff.lists.length > 0 && html`<section>
      <h4 class="chm-diff-h">${t('Inventaire, qualités, contacts…')}</h4>
      ${diff.lists.map((l) => html`<div class="chm-diff-list" key=${l.list}>
        <div class="chm-diff-listname">${tIfKnown(l.label)}</div>
        <ul>
          ${l.added.map((n, i) => html`<li class="chm-add" key=${'a' + i}>+ ${n}</li>`)}
          ${l.removed.map((n, i) => html`<li class="chm-del" key=${'r' + i}>− ${n}</li>`)}
          ${l.changed.map((n, i) => html`<li class="chm-chg" key=${'c' + i}>~ ${n}</li>`)}
        </ul>
      </div>`)}
    </section>`}
  </div>`;
}

function Warnings({ list, i18n }) {
  const items = texts(list, i18n);
  if (!items.length) return null;
  return html`<div class="chm-warn"><b>${t('Points d’attention')}</b><ul>${items.map((w, i) => html`<li key=${i}>${w}</li>`)}</ul></div>`;
}

/** Confirmation dialog for a re-import. */
function UpdateDialog({ actor, preview, busy, onConfirm, onClose, gm }) {
  const needsApproval = preview.needsApproval;
  return html`<${Overlay} title=${t('Mettre à jour {name} depuis Chummer', { name: actor.name })} onClose=${onClose} width=${680} class="chm-modal">
    <div class="col">
      <div class="muted small">
        ${withBold(t('Fichier {file}', { file: MARK }), preview.fileName || t('(sans nom)'))}${preview.created === false ? html` · <${Badge} color="amber">${t('mode création')}</${Badge}>` : null}
        ${preview.linked
          ? ` — ${t('fusion avec la dernière version synchronisée : les changements faits dans l’app depuis (récompenses, achats, dégâts…) sont conservés quand Chummer ne les a pas modifiés.')}`
          : ` — ${t('fiche non liée à Chummer jusqu’ici : les valeurs du fichier remplacent celles de la fiche (historique, notes MJ, portrait et entraînements sont conservés).')}`}
      </div>
      <${Warnings} list=${preview.warnings} i18n=${preview.warningsI18n} />
      <${DiffView} diff=${preview.diff} />
      <div class="row spread wrap">
        <span class="muted small">${needsApproval ? t('Le MJ doit valider cette mise à jour.') : gm ? '' : t('Le MJ a autorisé les mises à jour depuis Chummer.')}</span>
        <div class="row">
          <${Button} variant="ghost" onClick=${onClose}>${t('Annuler')}</${Button}>
          <${Button} variant="primary" disabled=${busy || preview.diff?.empty} onClick=${onConfirm}>${needsApproval ? t('Envoyer au MJ') : t('Appliquer les changements')}</${Button}>
        </div>
      </div>
    </div>
  </${Overlay}>`;
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------
/** GM: create a new actor from a .chum5 (or an exported JSON sheet). `label` = already translated text (default: « Importer un .chum5 »). */
export function ChummerImportButton({ type = 'pc', label, variant = 'ghost', small }) {
  const [busy, setBusy] = useState(false);
  const [input, pick] = useFilePicker(async (file, text) => {
    setBusy(true);
    try {
      const res = await postText(`/api/chummer/import?type=${type}&fileName=${encodeURIComponent(file.name)}`, text);
      toast(t('Fiche importée : {name}', { name: file.name }), 'success');
      const warnings = texts(res.warnings, res.warningsI18n);
      if (warnings.length) toast(warnings[0], 'warn', 7000);
      openSheet(res.actorId);
    } catch (err) {
      toast(err.message || t('Import impossible'), 'error');
    } finally {
      setBusy(false);
    }
  });
  return html`<${Button} variant=${variant} small=${small} disabled=${busy} onClick=${pick} title=${t('Fiche Chummer5a (.chum5) ou export JSON d’une fiche')}>${busy ? t('Import…') : label ?? t('Importer un .chum5')}</${Button}>${input}`;
}

/** Export button + warnings dialog. */
export function ChummerExportButton({ actor, small = true }) {
  const [busy, setBusy] = useState(false);
  const [warn, setWarn] = useState(null);
  const go = async () => {
    setBusy(true);
    try {
      const r = await downloadChum5(actor);
      toast(t('{file} téléchargé', { file: r.name }), 'success');
      if (r.warnings.length || r.warningsI18n.length) setWarn(r);
    } catch (err) {
      toast(err.message || t('Export impossible'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return html`<${Button} small=${small} variant="ghost" disabled=${busy} onClick=${go} title=${t('Télécharger la fiche au format Chummer5a pour l’ouvrir et la modifier dans Chummer')}>⇩ ${busy ? t('Export…') : t('Exporter vers Chummer (.chum5)')}</${Button}>
    ${warn && html`<${Overlay} title=${t('Export Chummer : points d’attention')} onClose=${() => setWarn(null)} width=${560}>
      <div class="col">
        <div class="muted small">${warn.mode === 'generate'
          ? t('{file} a été téléchargé. Le fichier a été généré à partir de la fiche de l’app (aucun fichier Chummer d’origine).', { file: warn.name })
          : t('{file} a été téléchargé. Le fichier Chummer d’origine a été mis à jour.', { file: warn.name })}</div>
        <${Warnings} list=${warn.warnings} i18n=${warn.warningsI18n} />
        <div class="muted small">${withBold(t('Dans Chummer, utilise {menu} pour recalculer les bonus des objets ajoutés depuis l’app.', { menu: MARK }), t('Spécial › Réappliquer les améliorations'))}</div>
        <div class="row" style=${{ justifyContent: 'flex-end' }}><${Button} variant="primary" onClick=${() => setWarn(null)}>${t('OK')}</${Button}></div>
      </div>
    </${Overlay}>`}`;
}

/** Re-import a .chum5 into an existing actor, with a diff confirmation. */
export function ChummerUpdateButton({ game, actor, small = true }) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const gm = isGM(game);
  const [input, pick] = useFilePicker(async (file, text) => {
    setBusy(true);
    try {
      const p = await postText(`/api/chummer/preview?actorId=${encodeURIComponent(actor.id)}&fileName=${encodeURIComponent(file.name)}`, text);
      setPreview({ ...p, text, fileName: file.name });
    } catch (err) {
      toast(err.message || t('Fichier illisible'), 'error');
    } finally {
      setBusy(false);
    }
  });
  const confirm = async () => {
    setBusy(true);
    try {
      const r = await postText(`/api/chummer/update?actorId=${encodeURIComponent(actor.id)}&fileName=${encodeURIComponent(preview.fileName)}`, preview.text);
      toast(r.applied ? t('{name} mis à jour depuis Chummer', { name: actor.name }) : t('Demande envoyée au MJ'), r.applied ? 'success' : 'info');
      setPreview(null);
    } catch (err) {
      toast(err.message || t('Mise à jour impossible'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return html`<${Button} small=${small} variant="ghost" disabled=${busy} onClick=${pick} title=${t('Recharger la fiche depuis un fichier Chummer modifié (aperçu des changements avant validation)')}>⇧ ${busy && !preview ? t('Lecture…') : t('Mettre à jour depuis un .chum5')}</${Button}>${input}
    ${preview && html`<${UpdateDialog} actor=${actor} preview=${preview} busy=${busy} gm=${gm} onConfirm=${confirm} onClose=${() => setPreview(null)} />`}`;
}

/** Strip shown in the sheet header for the GM and the owning player. */
export function ChummerSheetBar({ game, actor }) {
  const gm = isGM(game);
  const own = gm || (game?.me?.characterIds || []).includes(actor.id);
  if (!own || !actor.attributes) return null;
  const info = actor.chummer;
  const pending = (game.chummer?.pending || []).filter((r) => r.actorId === actor.id && r.status === 'pending');
  const lastDone = !gm && (game.chummer?.pending || []).filter((r) => r.actorId === actor.id && r.status !== 'pending').sort((a, b) => (b.resolvedAt || 0) - (a.resolvedAt || 0))[0];
  const unlink = async () => {
    if (!(await confirmAction(t('Délier {name} de son fichier Chummer ? Le prochain export générera un nouveau fichier.', { name: actor.name })))) return;
    send('chummer/unlink', { actorId: actor.id }).then(() => toast(t('Fiche déliée de Chummer'), 'success')).catch(() => {});
  };
  return html`<div class="chm-bar">
    <span class="chm-logo" title="Chummer5a">C5</span>
    <span class="chm-status small">
      ${info
        ? html`${withBold(t('Liée à {file}', { file: MARK }), info.fileName || t('un fichier Chummer'))}<span class="faint"> · ${t('synchro {when}', { when: fmtWhen(info.syncedAt || info.exportedAt || info.importedAt) })}</span>${info.created === false ? html` <${Badge} color="amber" title=${t('Le personnage n’est pas finalisé dans Chummer')}>${t('création')}</${Badge}>` : null}`
        : html`<span class="muted">${t('Pas encore lié à Chummer')}</span>`}
      ${actor.realName && html`<span class="faint"> · ${t('nom réel : {name}', { name: actor.realName })}</span>`}
      ${pending.length > 0 && html` <${Badge} color="amber">${t('mise à jour en attente du MJ')}</${Badge}>`}
      ${lastDone && html` <${Badge} color=${lastDone.status === 'approved' ? 'green' : 'red'} title=${lastDone.gmNote || ''}>${lastDone.status === 'approved' ? t('dernière demande validée') : t('dernière demande refusée')}</${Badge}>`}
    </span>
    <div class="row wrap gap-s chm-actions">
      <${ChummerExportButton} actor=${actor} />
      <${ChummerUpdateButton} game=${game} actor=${actor} />
      ${!gm && pending.length > 0 && html`<${Button} small variant="ghost" onClick=${() => send('chummer/cancel', { requestId: pending[0].id }).catch(() => {})}>${t('Annuler la demande')}</${Button}>`}
      ${gm && info && html`<${Button} small variant="ghost" onClick=${unlink} title=${t('Oublier le fichier Chummer associé')}>${t('Délier')}</${Button}>`}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// GM panel (CharactersPage)
// ---------------------------------------------------------------------------
function RequestRow({ game, r }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const actor = game.actors?.[r.actorId];
  const name = actor?.name || r.actorName;
  const resolve = async (approve) => {
    setBusy(true);
    try {
      await send('chummer/resolve', { requestId: r.id, approve });
      toast(approve ? t('{name} mis à jour', { name }) : t('Demande refusée'), approve ? 'success' : 'info');
      setOpen(false);
    } catch {
    } finally {
      setBusy(false);
    }
  };
  const summary = Array.isArray(r.summaryI18n) ? r.summaryI18n.map((p) => t(p.t, p.params)).join(', ') : tIfKnown(r.summary);
  return html`<div class="chm-req">
    <div class="chm-req-main">
      <button type="button" class="chm-req-name" onClick=${() => actor && openSheet(actor.id)}>${name}</button>
      <span class="muted small">${t('par {user} · {when} · {file}', { user: r.userName, when: fmtWhen(r.ts), file: r.fileName || t('fichier .chum5') })}</span>
      <div class="small">${summary}</div>
    </div>
    <div class="row gap-s">
      <${Button} small variant="ghost" onClick=${() => setOpen(true)}>${t('Voir les changements')}</${Button}>
      <${Button} small variant="danger" disabled=${busy} onClick=${() => resolve(false)}>${t('Refuser')}</${Button}>
      <${Button} small variant="primary" disabled=${busy} onClick=${() => resolve(true)}>${t('Valider')}</${Button}>
    </div>
    ${open && html`<${Overlay} title=${t('Demande de {user} — {name}', { user: r.userName, name })} onClose=${() => setOpen(false)} width=${680}>
      <div class="col">
        <div class="muted small">${t('Changements calculés à l’envoi de la demande ; ils seront recalculés sur la fiche actuelle au moment de la validation.')}</div>
        <${Warnings} list=${r.warnings} i18n=${r.warningsI18n} />
        <${DiffView} diff=${r.diff} />
        <div class="row" style=${{ justifyContent: 'flex-end' }}>
          <${Button} variant="ghost" onClick=${() => setOpen(false)}>${t('Fermer')}</${Button}>
          <${Button} variant="danger" disabled=${busy} onClick=${() => resolve(false)}>${t('Refuser')}</${Button}>
          <${Button} variant="primary" disabled=${busy} onClick=${() => resolve(true)}>${t('Valider')}</${Button}>
        </div>
      </div>
    </${Overlay}>`}
  </div>`;
}

export function ChummerGmPanel({ game }) {
  if (!isGM(game)) return null;
  const s = game.chummer || { allowPlayerImport: true, pending: [] };
  const pending = (s.pending || []).filter((r) => r.status === 'pending');
  return html`<section class="panel chm-panel">
    <header class="panel-head">
      <h3><span class="chm-logo">C5</span> Chummer ${pending.length > 0 && html`<${Badge} color="amber">${t('{n} demande(s)', { n: pending.length })}</${Badge}>`}</h3>
      <div class="panel-actions">
        <${Toggle} value=${s.allowPlayerImport !== false} onChange=${(v) => send('chummer/settings', { allowPlayerImport: v }).catch(() => {})}
          label=${t('Autoriser les joueurs à importer depuis Chummer')} title=${t('Activé : les joueurs mettent à jour leur fiche eux-mêmes. Désactivé : chaque envoi crée une demande à valider ici.')} />
      </div>
    </header>
    <div class="panel-body">
      ${pending.length
        ? html`<div class="chm-reqs">${pending.map((r) => html`<${RequestRow} key=${r.id} game=${game} r=${r} />`)}</div>`
        : html`<div class="muted small">${s.allowPlayerImport !== false
            ? t('Les joueurs peuvent exporter leur fiche (.chum5), la modifier dans Chummer puis la recharger eux-mêmes depuis leur fiche.')
            : t('Les mises à jour envoyées par les joueurs apparaîtront ici pour validation.')}</div>`}
    </div>
  </section>`;
}
