// GM assistant — server administration (/admin « Assistant IA »): connection status, public key to register in
// the Claude Console, which tables may use it, model, effort, monthly cap and this month's spend.
import type { Express, RequestHandler, Response } from 'express';
import type { I18nParams } from '../../../shared/types.ts';
import type { StoredMeta } from '../tables.ts';
import { getSettings, updateSettings, MODELS, EFFORTS, MAX_CAP } from './config.ts';
import type { AssistantSettings, Effort } from './config.ts';
import { budgetStatus, monthUsage, resetMonth, record } from './budget.ts';
import { authStatus, publicJwks, getClient, authMode, markCallOk } from './auth.ts';

/** What server/lib/admin.ts passes to the admin route registrations. */
export interface AssistantAdminOptions {
  requireAdmin: RequestHandler;
  /** Error reply: `key` = French message with {placeholders}. */
  fail: (res: Response, status: number, key: string, extra?: Record<string, unknown>, params?: I18nParams) => unknown;
  listMetas: () => StoredMeta[];
}

export function registerAssistantAdminRoutes(app: Express, { requireAdmin, fail, listMetas }: AssistantAdminOptions): void {
  const payload = () => {
    const settings = getSettings();
    let jwks: ReturnType<typeof publicJwks> | null = null;
    let keyError: string | null = null;
    try {
      jwks = publicJwks();
    } catch (err) {
      keyError = String((err as Error)?.message || err);
    }
    return {
      settings,
      models: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label, input: m.input, output: m.output })),
      efforts: EFFORTS,
      maxCap: MAX_CAP,
      auth: authStatus(),
      jwks,
      keyError,
      budget: budgetStatus(),
      usage: monthUsage(),
      // Public demo tables can never use the (paid) assistant: not offered here.
      tables: listMetas().filter((m) => !m.archived && !m.demo).map((m) => ({ id: m.id, name: m.name, enabled: settings.enabledTables.includes(m.id) })),
    };
  };

  app.get('/api/admin/assistant', requireAdmin, (req, res) => res.json(payload()));

  app.patch('/api/admin/assistant', requireAdmin, (req, res) => {
    const b = req.body || {};
    const patch: Partial<AssistantSettings> = {};
    if (Array.isArray(b.enabledTables)) {
      const known = new Set(listMetas().filter((m) => !m.demo).map((m) => m.id));
      patch.enabledTables = b.enabledTables.filter((id: unknown): id is string => known.has(id as string));
    }
    if (b.model !== undefined) {
      if (!MODELS[b.model]) return fail(res, 400, 'Modèle d’IA inconnu');
      patch.model = b.model;
    }
    if (b.effort !== undefined) {
      if (!EFFORTS.includes(b.effort as Effort)) return fail(res, 400, 'Niveau d’effort inconnu');
      patch.effort = b.effort;
    }
    if (b.monthlyCapUsd !== undefined) {
      const cap = Number(b.monthlyCapUsd);
      if (!Number.isFinite(cap) || cap < 0 || cap > MAX_CAP) return fail(res, 400, 'Plafond invalide (0 à {max} $)', {}, { max: MAX_CAP });
      patch.monthlyCapUsd = cap;
    }
    updateSettings(patch);
    res.json(payload());
  });

  app.post('/api/admin/assistant/reset-month', requireAdmin, (req, res) => {
    resetMonth();
    res.json(payload());
  });

  // One tiny request to check the credentials end to end (costs a fraction of a cent, counted in the ledger).
  app.post('/api/admin/assistant/test', requireAdmin, async (req, res) => {
    const client = getClient();
    if (!client) return fail(res, 503, 'L’assistant n’est pas connecté à l’API Claude (voir /admin).');
    if (!budgetStatus().allowed) return fail(res, 402, 'Budget mensuel de l’assistant atteint ({cap} $).', {}, { cap: getSettings().monthlyCapUsd });
    const model = getSettings().model;
    try {
      const msg = await client.messages.create({
        model,
        max_tokens: 400,
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: 'Réponds seulement « OK ».' }],
      });
      markCallOk();
      const usd = record({ usage: msg.usage, model: msg.model || model, tableId: 'admin-test' });
      const text = msg.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join(' ').slice(0, 80);
      res.json({ ok: true, mode: authMode(), model: msg.model, reply: text, usd, ...payload() });
    } catch (err) {
      const e = err as { status?: number; message?: string };
      const status = e?.status;
      const message = String(e?.message || err).slice(0, 400);
      console.error('[assistant] admin test failed', status, message);
      return fail(res, 502, 'Échec du test de connexion ({status}) : {message}', {}, { status: status ?? '?', message });
    }
  });
}
