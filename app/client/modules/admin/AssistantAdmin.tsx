// /admin « Assistant IA »: connection to the Claude API (Workload Identity Federation), public key to register in
// the Claude Console, tables allowed to use the GM assistant, model, effort, monthly cap and spend.
// Server: server/lib/assistant/admin-routes.js.
import { useEffect, useState } from 'react';
import { Button, Field, Select, Toggle, Badge, confirmAction } from '../../lib/ui.tsx';
import { toast } from '../../lib/ui-store.ts';
import { t, tk, fmtNumber, fmtDate, getLang } from '../../lib/i18n.ts';
import type { AdminApi, RunFn } from './types.ts';

const usd = (n: unknown) => {
  const v = fmtNumber(Number(n) || 0, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return getLang() === 'en' ? `$${v}` : `${v} $`;
};
const EFFORT_LABEL: Record<string, string> = { low: tk('Low (fast, cheap)'), medium: tk('Medium (recommended)'), high: tk('High (more thorough, more expensive)') };

function copy(text: string) {
  try {
    navigator.clipboard.writeText(text);
    toast(t('Copied'), 'success');
  } catch {
    toast(t('Copy failed: select the text by hand'), 'warn');
  }
}

/** GET/PATCH /api/admin/assistant (server/lib/assistant/admin-routes.js). */
interface AssistantInfo {
  auth: {
    mode: 'wif' | 'apikey' | null | '';
    lastOk?: number | null;
    lastError?: string | null;
    lastErrorAt?: number | null;
    ruleConfigured?: boolean;
    orgConfigured?: boolean;
    issuer: string;
    subject: string;
    subjectPrefix: string;
  };
  settings: { monthlyCapUsd: number; enabledTables: string[]; model: string; effort: string };
  budget: { month: string; spent: number; cap: number };
  usage: { calls: number; tables?: Record<string, { usd: number }> };
  tables: { id: string; name: string; enabled: boolean }[];
  models: { id: string; label: string; input: number; output: number }[];
  efforts: string[];
  maxCap: number;
  jwks?: unknown;
  keyError?: string;
  /** Test call reply only. */
  model?: string;
  usd?: number;
}

export default function AssistantAdmin({ adminApi, run }: { adminApi: AdminApi; run: RunFn }) {
  const [d, setD] = useState<AssistantInfo | null>(null);
  const [cap, setCap] = useState('');
  const [testing, setTesting] = useState(false);
  const load = () =>
    run(async () => {
      const r = await adminApi<AssistantInfo>('/api/admin/assistant');
      setD(r);
      setCap(String(r.settings.monthlyCapUsd));
    });
  useEffect(() => {
    load();
  }, []);
  if (!d) return <div className="muted small">{t('Loading…')}</div>;

  const patch = (body: object) =>
    run(async () => {
      const r = await adminApi<AssistantInfo>('/api/admin/assistant', { method: 'PATCH', body });
      setD(r);
      setCap(String(r.settings.monthlyCapUsd));
    });
  const toggleTable = (id: string, on: boolean) => {
    const set = new Set(d.settings.enabledTables);
    if (on) set.add(id);
    else set.delete(id);
    patch({ enabledTables: [...set] });
  };
  const test = async () => {
    setTesting(true);
    await run(async () => {
      const r = await adminApi<AssistantInfo>('/api/admin/assistant/test', { method: 'POST' });
      setD(r);
      toast(t('Connection OK ({model}) — cost {usd}', { model: r.model, usd: usd(r.usd) }), 'success');
    });
    setTesting(false);
  };
  const reset = async () => {
    if (!(await confirmAction(t('Reset this month\'s spend counter? (The Claude Console limit remains the real safeguard.)')))) return;
    run(async () => setD(await adminApi<AssistantInfo>('/api/admin/assistant/reset-month', { method: 'POST' })));
  };

  const a = d.auth;
  const jwksText = d.jwks ? JSON.stringify(d.jwks, null, 2) : '';
  const modeBadge =
    a.mode === 'wif' ? (
      <Badge color="green">{t('Identity federation')}</Badge>
    ) : a.mode === 'apikey' ? (
      <Badge color="amber">{t('API key (development)')}</Badge>
    ) : (
      <Badge color="red">{t('Not configured')}</Badge>
    );
  const b = d.budget;

  return (
    <div className="col" style={{ gap: 12 }}>
      <p className="field-hint">
        {t('The GM assistant uses Claude to answer the GM\'s questions and prepare maps, NPCs and documents. Players never see it, and it changes nothing until the GM clicks « Apply ».')}
      </p>

      <div className="grid-2">
        <div className="col" style={{ gap: 8 }}>
          <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
            <strong>{t('Connection')}</strong> {modeBadge}
          </div>
          <div className="small">
            {a.lastOk ? <div>{t('Last successful call: {date}', { date: fmtDate(a.lastOk) })}</div> : null}
            {a.lastError ? <div style={{ color: 'var(--red)' }}>{t('Last error ({date}): {error}', { date: fmtDate(a.lastErrorAt), error: a.lastError })}</div> : null}
            {a.mode !== 'wif' ? (
              <div className="muted">{t('Federation rule: {rule} · Organization: {org}', { rule: a.ruleConfigured ? '✓' : '✗', org: a.orgConfigured ? '✓' : '✗' })}</div>
            ) : null}
          </div>
          <div className="row" style={{ gap: 6 }}>
            <Button small disabled={!a.mode || testing} onClick={test}>
              {testing ? t('Testing…') : t('Test the connection')}
            </Button>
          </div>

          <strong style={{ marginTop: 6 }}>{t('This month\'s budget ({month})', { month: b.month })}</strong>
          <div>
            {t('{spent} spent of {cap}', { spent: usd(b.spent), cap: usd(b.cap) })} · {t('{n} calls', { n: d.usage.calls })}
          </div>
          {Object.keys(d.usage.tables || {}).length ? (
            <div className="small muted">
              {Object.entries(d.usage.tables || {})
                .map(([id, u]) => `${d.tables.find((x) => x.id === id)?.name || id} : ${usd(u.usd)}`)
                .join(' · ')}
            </div>
          ) : null}
          <Field
            label={t('Monthly cap (USD, all tables)')}
            hint={t('The assistant refuses questions once the cap is reached. Set the same limit on the workspace in the Claude Console.')}
          >
            <div className="row" style={{ gap: 6 }}>
              <input className="input" type="number" min="0" max={d.maxCap} step="1" value={cap} onChange={(e) => setCap(e.target.value)} style={{ maxWidth: 120 }} />
              <Button small disabled={Number(cap) === d.settings.monthlyCapUsd} onClick={() => patch({ monthlyCapUsd: Number(cap) })}>
                {t('Save')}
              </Button>
              <Button small variant="ghost" onClick={reset}>
                {t('Reset')}
              </Button>
            </div>
          </Field>
          <Field label={t('Model')}>
            <Select
              value={d.settings.model}
              options={d.models.map((m) => ({ value: m.id, label: t('{label} — ${input} / ${output} per million tokens', { label: m.label, input: m.input, output: m.output }) }))}
              onChange={(v) => patch({ model: v })}
            />
          </Field>
          <Field label={t('Effort')}>
            <Select value={d.settings.effort} options={d.efforts.map((e) => ({ value: e, label: t(EFFORT_LABEL[e] || e) }))} onChange={(v) => patch({ effort: v })} />
          </Field>
          <strong style={{ marginTop: 6 }}>{t('Allowed tables')}</strong>
          {d.tables.map((tb) => (
            <Toggle key={tb.id} value={tb.enabled} label={tb.name} onChange={(v) => toggleTable(tb.id, v)} />
          ))}
        </div>

        <div className="col" style={{ gap: 8 }}>
          <strong>{t('Claude Console setup (once)')}</strong>
          <ol className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
            <li>{t('Workspaces → create a « shadowrun-table » workspace with a monthly spend limit.')}</li>
            <li>{t('Workload identity → Connect workload → Custom OIDC: issuer URL and inline JWKS (below).')}</li>
            <li>{t('Service account in that workspace only; rule limited to that workspace, scope « workspace:inference », subject prefix below.')}</li>
            <li>{t('On the server: deploy.ps1 -Action ai-setup with the rule ID and organization ID (see DEPLOY.md).')}</li>
          </ol>
          <Field label={t('Issuer URL')}>
            <div className="row" style={{ gap: 6 }}>
              <input className="input mono" readOnly value={a.issuer ?? ''} />
              <Button small onClick={() => copy(a.issuer)}>
                {t('Copy')}
              </Button>
            </div>
          </Field>
          <Field label={t('Subject prefix')} hint={t('This server\'s subject: {sub}', { sub: a.subject })}>
            <div className="row" style={{ gap: 6 }}>
              <input className="input mono" readOnly value={a.subjectPrefix ?? ''} />
              <Button small onClick={() => copy(a.subjectPrefix)}>
                {t('Copy')}
              </Button>
            </div>
          </Field>
          <Field label={t('JWKS (public key, paste inline)')} hint={t('Only the public key is shown: the private key never leaves the server.')}>
            {d.keyError ? (
              <div style={{ color: 'var(--red)' }} className="small">
                {d.keyError}
              </div>
            ) : (
              <>
                <textarea className="input mono" readOnly rows={8} style={{ fontSize: 11 }} value={jwksText} />
                <div>
                  <Button small onClick={() => copy(jwksText)}>
                    {t('Copy the JWKS')}
                  </Button>
                </div>
              </>
            )}
          </Field>
        </div>
      </div>
    </div>
  );
}
