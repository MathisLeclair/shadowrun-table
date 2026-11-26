// « Livres de règles » panel of the /admin page: the server-wide rulebook library (see ARCHITECTURE.md « Rulebooks »).
// List (code, name, pages, offset, indexing state), upload a PDF (streamed), edit offset(s) / names / allowed tables,
// detect the offset again, re-index, delete.
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, Button, Field, Toggle, Badge, Empty, Modal, promptText } from '../../lib/ui.js';
import { uploadWithProgress } from '../../lib/net.js';
import { toast } from '../../lib/ui-store.js';
import { t, tn, tIfKnown, fmtDate } from '../../lib/i18n.js';
import { fmtBytes, Progress } from './common.js';

const pct = (x) => `${Math.round((Number(x) || 0) * 100)} %`;
const offsetText = (b) => [`${b.offset >= 0 ? '+' : ''}${b.offset}`, ...(b.offsets || []).map((r) => t('dès p. {from} : {off}', { from: r.fromPrinted, off: `${r.offset >= 0 ? '+' : ''}${r.offset}` }))].join(' · ');
const rangesToText = (list) => (list || []).map((r) => `${r.fromPrinted}:${r.offset}`).join(', ');
function textToRanges(s) {
  const out = [];
  for (const part of String(s || '').split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)[:=](-?\d+)$/);
    if (!m) return null;
    out.push({ fromPrinted: Number(m[1]), offset: Number(m[2]) });
  }
  return out;
}

function EditBook({ book, tables, adminApi, onClose, onSaved }) {
  const [f, setF] = useState({ name: book.name, nameFr: book.nameFr, offset: String(book.offset), ranges: rangesToText(book.offsets), all: book.tables === 'all', tables: Array.isArray(book.tables) ? book.tables : [] });
  const [busy, setBusy] = useState(false);
  const [detected, setDetected] = useState(null); // { offset, ranges } previewed by « Détecter » (saved only with the dialog)
  const set = (p) => setF((cur) => ({ ...cur, ...p }));
  const save = async () => {
    const offsets = textToRanges(f.ranges);
    if (offsets === null) return toast(t('Plages invalides : écris « page:décalage », ex. 120:4, 250:6'), 'error');
    if (!/^-?\d+$/.test(f.offset.trim())) return toast(t('Décalage invalide'), 'error');
    setBusy(true);
    try {
      const body = { name: f.name, nameFr: f.nameFr, tables: f.all ? 'all' : f.tables };
      const changed = Number(f.offset) !== book.offset || rangesToText(offsets) !== rangesToText(book.offsets);
      // Kept exactly as detected: apply the detection (offset no longer « manuel », confidence updated).
      const useDetected = detected && Number(f.offset) === detected.offset && rangesToText(offsets) === detected.ranges;
      if (changed && !useDetected) Object.assign(body, { offset: Number(f.offset), offsets });
      await adminApi(`/api/admin/books/${book.code}`, { method: 'PATCH', body });
      if (useDetected) await adminApi(`/api/admin/books/${book.code}/detect`, { method: 'POST' });
      toast(t('Livre {code} enregistré', { code: book.code }), 'success');
      onSaved();
      onClose();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const detect = async () => {
    setBusy(true);
    try {
      const r = await adminApi(`/api/admin/books/${book.code}/detect?apply=0`, { method: 'POST' });
      set({ offset: String(r.book.offset), ranges: rangesToText(r.book.offsets) });
      setDetected({ offset: r.book.offset, ranges: rangesToText(r.book.offsets) });
      toast(t('Décalage détecté : {off} (confiance {conf}) — « Enregistrer » pour l’appliquer', { off: offsetText(r.book), conf: pct(r.book.confidence) }), 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return html`<${Modal} title=${t('Livre {code}', { code: book.code })} width=${620} onClose=${onClose}>
    <div class="admin-form">
      <${Field} label=${t('Nom (anglais)')}><input class="input" value=${f.name} maxlength="120" onInput=${(e) => set({ name: e.target.value })} /></${Field}>
      <${Field} label=${t('Nom (français)')}><input class="input" value=${f.nameFr} maxlength="120" onInput=${(e) => set({ nameFr: e.target.value })} /></${Field}>
      <${Field} label=${t('Décalage')} hint=${t('Page du PDF = page imprimée + décalage.')}>
        <div class="row gap-s"><input class="input mono" style="width:90px" value=${f.offset} onInput=${(e) => set({ offset: e.target.value })} />
        <${Button} small onClick=${detect} disabled=${busy || !book.indexed} title=${t('Relit les numéros de page du PDF indexé')}>${t('Détecter')}</${Button}></div>
      </${Field}>
      <${Field} label=${t('Changements de décalage (optionnel)')} hint=${t('« page:décalage » séparés par des virgules, ex. 120:4 — pour les livres avec des pages couleur non numérotées.')}>
        <input class="input mono" value=${f.ranges} onInput=${(e) => set({ ranges: e.target.value })} placeholder="120:4, 250:6" />
      </${Field}>
    </div>
    <div class="col" style="margin-top:12px">
      <${Toggle} value=${f.all} onChange=${(v) => set({ all: v })} label=${t('Lisible par toutes les tables')} />
      ${!f.all && html`<div class="admin-worlds">
        ${tables.map((tb) => html`<label class="admin-world">
          <input type="checkbox" checked=${f.tables.includes(tb.id)} onChange=${(e) => set({ tables: e.target.checked ? [...f.tables, tb.id] : f.tables.filter((x) => x !== tb.id) })} />
          <span>${tb.name}</span><span class="mono">${tb.id}</span>${tb.archived && html`<${Badge} color="amber">${t('archivée')}</${Badge}>`}
        </label>`)}
        ${!tables.length && html`<span class="muted small">${t('Aucune table.')}</span>`}
      </div>`}
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:14px;gap:8px">
      <${Button} variant="ghost" onClick=${onClose}>${t('Annuler')}</${Button}>
      <${Button} variant="primary" disabled=${busy} onClick=${save}>${t('Enregistrer')}</${Button}>
    </div>
  </${Modal}>`;
}

function UploadBook({ known, maxBytes, token, onDone }) {
  const [file, setFile] = useState(null);
  const [code, setCode] = useState('');
  const [replace, setReplace] = useState(false);
  const [progress, setProgress] = useState(null);
  const guess = (name) => {
    const n = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    if (/core ?rules|5th ?edition/.test(n)) return 'SR5';
    let best = '';
    for (const k of known) {
      const kn = k.name.toLowerCase().replace(/&|\band\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
      if (kn && n.replace(/\band\b/g, ' ').replace(/\s+/g, ' ').includes(kn) && kn.length > best.length) best = k.code;
    }
    return best;
  };
  const submit = async () => {
    if (!file || !code) return;
    setProgress(0);
    try {
      const q = new URLSearchParams({ code: code.toUpperCase() });
      if (replace) q.set('replace', '1');
      await uploadWithProgress(`/api/admin/books/upload?${q}`, file, { token, headers: { 'X-Filename': encodeURIComponent(file.name).slice(0, 200) }, onProgress: (p) => setProgress(p >= 1 ? 'server' : p) });
      toast(t('Livre {code} reçu : indexation en cours', { code: code.toUpperCase() }), 'success');
      setFile(null);
      setCode('');
      setReplace(false);
      onDone();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setProgress(null);
    }
  };
  const knownName = known.find((k) => k.code === code.toUpperCase());
  return html`<div class="col">
    <div class="admin-file">
      <label class="btn">${t('Choisir un PDF')}<input type="file" accept=".pdf,application/pdf" class="hidden"
        onChange=${(e) => { const fl = e.target.files[0] || null; setFile(fl); if (fl && !code) setCode(guess(fl.name)); e.target.value = ''; }} /></label>
      ${file ? html`<span class="mono small">${file.name} (${fmtBytes(file.size)})</span>` : html`<span class="muted small">${t('Aucun fichier choisi')}</span>`}
    </div>
    <div class="admin-form">
      <${Field} label=${t('Code du livre')} hint=${knownName ? knownName.name : t('Code Chummer : SR5, RG, RF, SG, CF, DT, R5…')}>
        <input class="input mono" value=${code} maxlength="12" list="admin-book-codes" onInput=${(e) => setCode(e.target.value.toUpperCase())} />
        <datalist id="admin-book-codes">${known.map((k) => html`<option value=${k.code}>${k.name}</option>`)}</datalist>
      </${Field}>
      <${Field} label=${t('Si le code existe déjà')}><${Toggle} value=${replace} onChange=${setReplace} label=${t('Remplacer le PDF')} /></${Field}>
    </div>
    <span class="field-hint">${t('Taille max : {size}. Le texte est extrait et le décalage des pages détecté automatiquement après l’envoi.', { size: fmtBytes(maxBytes) })}</span>
    ${progress !== null && html`<${Progress} value=${progress} serverLabel=${t('Enregistrement sur le serveur…')} />`}
    <div class="row" style="justify-content:flex-end">
      <${Button} variant="primary" disabled=${!file || !code || progress !== null} onClick=${submit}>${t('Envoyer')}</${Button}>
    </div>
  </div>`;
}

export default function BooksAdmin({ adminApi, token, run }) {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null);
  const timer = useRef(null);
  const reload = () => run(async () => setData(await adminApi('/api/admin/books')));
  useEffect(() => {
    reload();
    return () => clearTimeout(timer.current);
  }, []);
  // Poll while something is being indexed.
  const busy = (data?.jobs || []).some((j) => j.state === 'running' || j.state === 'queued');
  useEffect(() => {
    clearTimeout(timer.current);
    if (busy) timer.current = setTimeout(() => adminApi('/api/admin/books').then(setData).catch(() => {}), 1500);
  }, [data]);

  if (!data) return html`<${Empty}>${t('Chargement…')}</${Empty}>`;
  const jobOf = (code) => data.jobs.find((j) => j.code === code);
  const reindex = (b) =>
    run(async () => {
      await adminApi(`/api/admin/books/${b.code}/reindex`, { method: 'POST', body: { detect: !b.manual } });
      reload();
    });
  const remove = async (b) => {
    const typed = await promptText(t('Supprimer le livre {code} ({name}) du serveur ? Le PDF et son index seront effacés. Tape « {code} » pour confirmer :', { code: b.code, name: b.name }));
    if (typed === null) return;
    if (typed.trim().toUpperCase() !== b.code) return toast(t('Code incorrect : rien n’a été supprimé'), 'warn');
    run(async () => {
      await adminApi(`/api/admin/books/${b.code}`, { method: 'DELETE', body: { confirm: b.code } });
      toast(t('Livre {code} supprimé', { code: b.code }), 'success');
      reload();
    });
  };
  const tableNames = (b) => (b.tables === 'all' ? t('toutes') : b.tables.map((id) => data.tables.find((x) => x.id === id)?.name || id).join(', ') || t('aucune'));

  return html`<div class="col">
    ${data.books.length
      ? html`<div style="overflow-x:auto"><table class="sr admin-tables">
          <thead><tr><th>${t('Code')}</th><th>${t('Livre')}</th><th class="right">${t('Pages')}</th><th>${t('Décalage')}</th><th>${t('Index')}</th><th>${t('Tables')}</th><th></th></tr></thead>
          <tbody>${data.books.map((b) => {
            const j = jobOf(b.code);
            const running = j && (j.state === 'running' || j.state === 'queued');
            return html`<tr key=${b.code}>
              <td class="mono">${b.code}</td>
              <td><div class="admin-name">${b.name}</div><div class="muted small">${b.nameFr !== b.name ? b.nameFr : ''}${b.size ? ` · ${fmtBytes(b.size)}` : ''}</div>
                ${!b.present && html`<${Badge} color="red">${t('PDF manquant')}</${Badge}>`}</td>
              <td class="num-cell">${b.pages || '—'}</td>
              <td class="small"><span class="mono">${offsetText(b)}</span>
                <div class="admin-badges">
                  ${b.manual ? html`<${Badge} color="amber">${t('manuel')}</${Badge}>` : b.confidence !== undefined && html`<${Badge} color=${b.confidence >= 0.8 ? 'green' : 'amber'} title=${t('Part des pages dont le numéro imprimé confirme le décalage')}>${pct(b.confidence)}</${Badge}>`}
                  ${b.verified === true && html`<${Badge} color="green" title=${t('La phrase de référence de Chummer est à la bonne page')}>${t('vérifié')}</${Badge}>`}
                </div></td>
              <td class="small">${running
                ? html`<${Progress} value=${j.total ? j.done / j.total : 0} serverLabel="" />${j.total ? html`<span class="muted small">${j.done}/${j.total}</span>` : html`<span class="muted small">${t('en attente…')}</span>`}`
                : j?.state === 'error'
                  ? html`<${Badge} color="red" title=${j.error ? tIfKnown(j.error, j.errorParams) : ''}>${t('échec')}</${Badge}>`
                  : b.indexed ? fmtDate(b.indexedAt) : html`<${Badge} color="amber">${t('non indexé')}</${Badge}>`}</td>
              <td class="small">${tableNames(b)}</td>
              <td><div class="admin-actions" style="min-width:0">
                <${Button} small onClick=${() => setEditing(b)} disabled=${running}>${t('Modifier')}</${Button}>
                <${Button} small variant="ghost" onClick=${() => reindex(b)} disabled=${running || !b.present}>${t('Réindexer')}</${Button}>
                <${Button} small variant="danger" onClick=${() => remove(b)} disabled=${running}>${t('Supprimer')}</${Button}>
              </div></td>
            </tr>`;
          })}</tbody>
        </table></div>`
      : html`<${Empty}>${t('Aucun livre. Envoie tes PDF ci-dessous ou lance tools/books-setup.js sur le serveur.')}</${Empty}>`}
    <p class="field-hint">${tn(data.books.length, '{n} livre partagé par les tables autorisées. Les joueurs les consultent depuis l’onglet « Règles » et les références de page.', '{n} livres partagés par les tables autorisées. Les joueurs les consultent depuis l’onglet « Règles » et les références de page.')}</p>
    <h4 class="section-title">${t('Ajouter un livre')}</h4>
    <${UploadBook} known=${data.known} maxBytes=${data.maxBytes} token=${token} onDone=${reload} />
    ${editing && html`<${EditBook} book=${editing} tables=${data.tables} adminApi=${adminApi} onClose=${() => setEditing(null)} onSaved=${reload} />`}
  </div>`;
}
