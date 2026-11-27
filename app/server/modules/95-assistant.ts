// GM assistant (« Assistant MJ ») — Claude in the GM's dock. GM-only HTTP routes; no game state slice.
// Conversations live in tables/<id>/assistant.json (lib/assistant/conversations.js), settings and spend in
// runtime/assistant/ (server-wide, managed in /admin). See ARCHITECTURE.md « Assistant MJ ».
import { errorBody, t as translate } from '../lib/i18n.ts';
import { getSettings, isTableEnabled, MODELS } from '../lib/assistant/config.ts';
import { budgetStatus } from '../lib/assistant/budget.ts';
import { authMode } from '../lib/assistant/auth.ts';
import { buildOps } from '../lib/assistant/tools.ts';
import { runTurn, isBusy, stop, viewConversation, publicProposal } from '../lib/assistant/run.ts';
import { listConversations, getConversation, createConversation, deleteConversation, findProposal, save } from '../lib/assistant/conversations.ts';
import type { ServerEvents, ServerModule, TableMeta, TableState } from '../../shared/types.ts';

// No Express types in the app yet (@types/express arrives with the server-core conversion): loose local aliases.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped Express app / request / response
type HttpApp = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Res = any;

/** The table a request runs on (`req.srTable`, server/tables.js). */
interface SrTable {
  id: string;
  meta?: TableMeta;
  state: TableState;
}

const MAX_QUESTION = 8000;

const mod: ServerModule<HttpApp> = {
  name: 'assistant',

  routes(app, { requireGM, emitTo, runAction, simulateAction }) {
    // A public demo table never reaches the (paid) API, whatever the admin settings say.
    const allowed = (t: SrTable) => !t.meta?.demo && isTableEnabled(t.id);
    const enabled = (req: Req, res: Res, next: () => void) => {
      if (!allowed(req.srTable)) return res.status(403).json(errorBody('The assistant is not enabled for this table (see /admin).', null, { code: 'assistant-off' }));
      next();
    };

    app.get('/api/assistant/status', requireGM, (req: Req, res: Res) => {
      const s = getSettings();
      res.json({
        enabled: allowed(req.srTable),
        connected: !!authMode(),
        model: s.model,
        modelLabel: MODELS[s.model as keyof typeof MODELS]?.label || s.model,
        budget: budgetStatus(),
        busy: isBusy(req.srTable.id),
      });
    });

    app.get('/api/assistant/conversations', requireGM, enabled, (req: Req, res: Res) => {
      res.json(listConversations(req.srTable));
    });

    app.post('/api/assistant/conversations', requireGM, enabled, (req: Req, res: Res) => {
      const cfg = req.srTable.state.config;
      const c = createConversation(req.srTable, req.body?.title || translate(cfg?.gmLang || cfg?.lang || 'fr', 'New conversation')); // default title in the GM's language
      res.json(viewConversation(c, req.srTable.state));
    });

    app.get('/api/assistant/conversations/:id', requireGM, enabled, (req: Req, res: Res) => {
      const c = getConversation(req.srTable, req.params.id);
      if (!c) return res.status(404).json(errorBody('Conversation not found'));
      res.json(viewConversation(c, req.srTable.state));
    });

    app.delete('/api/assistant/conversations/:id', requireGM, enabled, (req: Req, res: Res) => {
      if (isBusy(req.srTable.id)) return res.status(409).json(errorBody('The assistant is still answering'));
      if (!deleteConversation(req.srTable, req.params.id)) return res.status(404).json(errorBody('Conversation not found'));
      res.json({ ok: true });
    });

    // Ask a question. Answers immediately with the conversation id; the answer streams over the GM's socket
    // (assistant:delta / assistant:step / assistant:done), then the client reloads the conversation.
    app.post('/api/assistant/ask', requireGM, enabled, (req: Req, res: Res) => {
      const t = req.srTable;
      const text = String(req.body?.text || '').trim();
      if (!text) return res.status(400).json(errorBody('Empty question'));
      if (text.length > MAX_QUESTION) return res.status(400).json(errorBody('Question too long ({max} characters max)', { max: MAX_QUESTION }));
      if (isBusy(t.id)) return res.status(409).json(errorBody('The assistant is still answering'));
      if (!authMode()) return res.status(503).json(errorBody('The assistant is not connected to the Claude API (see /admin).'));
      const b = budgetStatus();
      if (!b.allowed) return res.status(402).json(errorBody('The assistant\'s monthly budget is used up (${cap}).', { cap: b.cap }));
      let c = req.body?.conversationId ? getConversation(t, String(req.body.conversationId)) : null;
      if (req.body?.conversationId && !c) return res.status(404).json(errorBody('Conversation not found'));
      if (!c) c = createConversation(t, text.slice(0, 60));
      const lang = req.body?.lang === 'en' ? 'en' : req.body?.lang === 'fr' ? 'fr' : t.state.config?.gmLang || t.state.config?.lang || 'fr';
      const user = req.user;
      res.json({ conversationId: c.id });
      // Runs inside this request's table scope (AsyncLocalStorage follows the promise chain).
      runTurn({
        table: t,
        conversation: c,
        text,
        lang,
        simulate: (type: string, payload: Record<string, unknown>, state?: TableState | null) => simulateAction(t, user, type, payload, state ?? undefined),
        emit: <E extends keyof ServerEvents>(event: E, data: ServerEvents[E]) => emitTo('gm', event, data),
      });
    });

    app.post('/api/assistant/stop', requireGM, enabled, (req: Req, res: Res) => {
      res.json({ stopped: stop(req.srTable.id) });
    });

    // Apply a proposal: re-build its actions from the CURRENT state and run them as the GM, in order.
    app.post('/api/assistant/proposals/:id/apply', requireGM, enabled, (req: Req, res: Res) => {
      const t = req.srTable;
      const found = findProposal(t, req.params.id);
      if (!found) return res.status(404).json(errorBody('Proposal not found'));
      const { proposal: p } = found;
      if (p.status === 'applied') return res.status(409).json(errorBody('Proposal already applied'));
      const built = buildOps(p.kind, p.input, t.state);
      if (built.error) {
        p.status = 'failed';
        p.error = built.error;
        save(t);
        return res.status(400).json(errorBody('The proposal cannot be applied: {reason}', { reason: built.error }));
      }
      const results: unknown[] = [];
      for (const op of built.ops!) {
        const r = runAction(t, req.user, op.type, op.payload);
        if (!r.ok) {
          p.status = results.length ? 'partial' : 'failed';
          p.error = r.error;
          save(t);
          return res.status(400).json({ ...errorBody('The proposal cannot be applied: {reason}', { reason: r.error }), applied: results.length });
        }
        results.push(r.result);
      }
      p.status = 'applied';
      p.appliedAt = Date.now();
      p.error = undefined;
      const first = results[0];
      p.result = p.kind === 'map' ? { mapId: first } : p.kind === 'map_edits' ? { mapId: p.input.mapId } : p.kind === 'npc' ? { templateId: (first as { templateId?: string } | undefined)?.templateId } : p.kind === 'handout' ? { handoutId: first } : {};
      save(t);
      res.json({ proposal: publicProposal(p) });
    });

    app.post('/api/assistant/proposals/:id/dismiss', requireGM, enabled, (req: Req, res: Res) => {
      const found = findProposal(req.srTable, req.params.id);
      if (!found) return res.status(404).json(errorBody('Proposal not found'));
      if (found.proposal.status === 'pending') found.proposal.status = 'dismissed';
      save(req.srTable);
      res.json({ proposal: publicProposal(found.proposal) });
    });
  },
};

export default mod;
