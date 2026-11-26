// /admin « Assistant IA »: connection to the Claude API (Workload Identity Federation), public key to register in
// the Claude Console, tables allowed to use the GM assistant, model, effort, monthly cap and spend.
// Server: server/lib/assistant/admin-routes.js.
import { useEffect, useState } from 'preact/hooks';
import { html, Button, Field, Select, Toggle, Badge, confirmAction } from '../../lib/ui.js';
import { toast } from '../../lib/ui-store.js';
import { t, tk, fmtNumber, fmtDate, getLang } from '../../lib/i18n.js';

const usd = (n) => {
  const v = fmtNumber(Number(n) || 0, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return getLang() === 'en' ? `$${v}` : `${v} $`;
};
const EFFORT_LABEL = { low: tk('Faible (rapide, économique)'), medium: tk('Moyen (recommandé)'), high: tk('Élevé (plus réfléchi, plus cher)') };

function copy(text) {
  try {
    navigator.clipboard.writeText(text);
    toast(t('Copié'), 'success');
  } catch {
    toast(t('Copie impossible : sélectionne le texte à la main'), 'warn');
  }
}

export default function AssistantAdmin({ adminApi, run }) {
  const [d, setD] = useState(null);
  const [cap, setCap] = useState('');
  const [testing, setTesting] = useState(false);
  const load = () => run(async () => {
    const r = await adminApi('/api/admin/assistant');
    setD(r);
    setCap(String(r.settings.monthlyCapUsd));
  });
  useEffect(() => {
    load();
  }, []);
  if (!d) return html`<div class="muted small">${t('Chargement…')}</div>`;

  const patch = (body) => run(async () => {
    const r = await adminApi('/api/admin/assistant', { method: 'PATCH', body });
    setD(r);
    setCap(String(r.settings.monthlyCapUsd));
  });
  const toggleTable = (id, on) => {
    const set = new Set(d.settings.enabledTables);
    if (on) set.add(id);
    else set.delete(id);
    patch({ enabledTables: [...set] });
  };
  const test = async () => {
    setTesting(true);
    await run(async () => {
      const r = await adminApi('/api/admin/assistant/test', { method: 'POST' });
      setD(r);
      toast(t('Connexion OK ({model}) — coût {usd}', { model: r.model, usd: usd(r.usd) }), 'success');
    });
    setTesting(false);
  };
  const reset = async () => {
    if (!(await confirmAction(t('Remettre à zéro le compteur de dépenses de ce mois ? (La limite de la Console Claude reste la vraie sécurité.)')))) return;
    run(async () => setD(await adminApi('/api/admin/assistant/reset-month', { method: 'POST' })));
  };

  const a = d.auth;
  const jwksText = d.jwks ? JSON.stringify(d.jwks, null, 2) : '';
  const modeBadge = a.mode === 'wif'
    ? html`<${Badge} color="green">${t('Fédération d’identité')}</${Badge}>`
    : a.mode === 'apikey'
      ? html`<${Badge} color="amber">${t('Clé API (développement)')}</${Badge}>`
      : html`<${Badge} color="red">${t('Non configuré')}</${Badge}>`;
  const b = d.budget;

  return html`<div class="col" style="gap:12px">
    <p class="field-hint">${t('L’assistant MJ utilise Claude pour répondre aux questions du MJ et préparer cartes, PNJ et documents. Il n’est jamais visible des joueurs et ne modifie rien sans le bouton « Appliquer » du MJ.')}</p>

    <div class="grid-2">
      <div class="col" style="gap:8px">
        <div class="row wrap" style="gap:8px;align-items:center"><strong>${t('Connexion')}</strong> ${modeBadge}</div>
        <div class="small">
          ${a.lastOk ? html`<div>${t('Dernier appel réussi : {date}', { date: fmtDate(a.lastOk) })}</div>` : null}
          ${a.lastError ? html`<div style="color:var(--red)">${t('Dernière erreur ({date}) : {error}', { date: fmtDate(a.lastErrorAt), error: a.lastError })}</div>` : null}
          ${a.mode !== 'wif' ? html`<div class="muted">${t('Règle de fédération : {rule} · Organisation : {org}', { rule: a.ruleConfigured ? '✓' : '✗', org: a.orgConfigured ? '✓' : '✗' })}</div>` : null}
        </div>
        <div class="row" style="gap:6px">
          <${Button} small disabled=${!a.mode || testing} onClick=${test}>${testing ? t('Test…') : t('Tester la connexion')}</${Button}>
        </div>

        <strong style="margin-top:6px">${t('Budget de ce mois ({month})', { month: b.month })}</strong>
        <div>${t('{spent} dépensés sur {cap}', { spent: usd(b.spent), cap: usd(b.cap) })} · ${t('{n} appels', { n: d.usage.calls })}</div>
        ${Object.keys(d.usage.tables || {}).length ? html`<div class="small muted">${Object.entries(d.usage.tables).map(([id, u]) => `${d.tables.find((x) => x.id === id)?.name || id} : ${usd(u.usd)}`).join(' · ')}</div>` : null}
        <${Field} label=${t('Plafond mensuel (USD, toutes tables)')} hint=${t('L’assistant refuse les questions une fois le plafond atteint. Mets la même limite sur l’espace de travail dans la Console Claude.')}>
          <div class="row" style="gap:6px">
            <input class="input" type="number" min="0" max=${d.maxCap} step="1" value=${cap} onInput=${(e) => setCap(e.target.value)} style="max-width:120px" />
            <${Button} small disabled=${Number(cap) === d.settings.monthlyCapUsd} onClick=${() => patch({ monthlyCapUsd: Number(cap) })}>${t('Enregistrer')}</${Button}>
            <${Button} small variant="ghost" onClick=${reset}>${t('Remettre à zéro')}</${Button}>
          </div>
        </${Field}>
        <${Field} label=${t('Modèle')}>
          <${Select} value=${d.settings.model} options=${d.models.map((m) => ({ value: m.id, label: t('{label} — {input} $ / {output} $ par million de jetons', { label: m.label, input: m.input, output: m.output }) }))} onChange=${(v) => patch({ model: v })} />
        </${Field}>
        <${Field} label=${t('Effort')}>
          <${Select} value=${d.settings.effort} options=${d.efforts.map((e) => ({ value: e, label: t(EFFORT_LABEL[e] || e) }))} onChange=${(v) => patch({ effort: v })} />
        </${Field}>
        <strong style="margin-top:6px">${t('Tables autorisées')}</strong>
        ${d.tables.map((tb) => html`<${Toggle} value=${tb.enabled} label=${tb.name} onChange=${(v) => toggleTable(tb.id, v)} />`)}
      </div>

      <div class="col" style="gap:8px">
        <strong>${t('Configuration dans la Console Claude (une fois)')}</strong>
        <ol class="small" style="margin:0;padding-left:18px;line-height:1.6">
          <li>${t('Workspaces → créer un espace « shadowrun-table » avec une limite de dépenses mensuelle.')}</li>
          <li>${t('Workload identity → Connect workload → Custom OIDC : URL de l’émetteur et JWKS en ligne (ci-dessous).')}</li>
          <li>${t('Compte de service membre de cet espace uniquement ; règle limitée à cet espace, portée « workspace:inference », préfixe de sujet ci-dessous.')}</li>
          <li>${t('Sur le serveur : deploy.ps1 -Action ai-setup avec l’identifiant de la règle et de l’organisation (voir DEPLOY.md).')}</li>
        </ol>
        <${Field} label=${t('URL de l’émetteur (issuer)')}>
          <div class="row" style="gap:6px"><input class="input mono" readonly value=${a.issuer} /><${Button} small onClick=${() => copy(a.issuer)}>${t('Copier')}</${Button}></div>
        </${Field}>
        <${Field} label=${t('Préfixe de sujet (subject prefix)')} hint=${t('Sujet de ce serveur : {sub}', { sub: a.subject })}>
          <div class="row" style="gap:6px"><input class="input mono" readonly value=${a.subjectPrefix} /><${Button} small onClick=${() => copy(a.subjectPrefix)}>${t('Copier')}</${Button}></div>
        </${Field}>
        <${Field} label=${t('JWKS (clé publique, à coller en ligne)')} hint=${t('Seule la clé publique est affichée : la clé privée ne quitte jamais le serveur.')}>
          ${d.keyError
            ? html`<div style="color:var(--red)" class="small">${d.keyError}</div>`
            : html`<textarea class="input mono" readonly rows="8" style="font-size:11px">${jwksText}</textarea>
              <div><${Button} small onClick=${() => copy(jwksText)}>${t('Copier le JWKS')}</${Button}></div>`}
        </${Field}>
      </div>
    </div>
  </div>`;
}
