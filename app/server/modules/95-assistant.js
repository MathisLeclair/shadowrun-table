// GM assistant (« Assistant MJ ») — Claude in the GM's dock. GM-only HTTP routes; no game state slice.
// Conversations live in tables/<id>/assistant.json (lib/assistant/conversations.js), settings and spend in
// runtime/assistant/ (server-wide, managed in /admin). See ARCHITECTURE.md « Assistant MJ ».
import { errorBody } from '../lib/i18n.js';
import { getSettings, isTableEnabled, MODELS } from '../lib/assistant/config.js';
import { budgetStatus } from '../lib/assistant/budget.js';
import { authMode } from '../lib/assistant/auth.js';
import { buildOps } from '../lib/assistant/tools.js';
import { runTurn, isBusy, stop, viewConversation, publicProposal } from '../lib/assistant/run.js';
import { listConversations, getConversation, createConversation, deleteConversation, findProposal, save } from '../lib/assistant/conversations.js';

const MAX_QUESTION = 8000;

export default {
  name: 'assistant',

  routes(app, { requireGM, emitTo, runAction, simulateAction }) {
    const enabled = (req, res, next) => {
      if (!isTableEnabled(req.srTable.id)) return res.status(403).json(errorBody('L’assistant n’est pas activé pour cette table (voir /admin).', null, { code: 'assistant-off' }));
      next();
    };

    app.get('/api/assistant/status', requireGM, (req, res) => {
      const s = getSettings();
      res.json({
        enabled: isTableEnabled(req.srTable.id),
        connected: !!authMode(),
        model: s.model,
        modelLabel: MODELS[s.model]?.label || s.model,
        budget: budgetStatus(),
        busy: isBusy(req.srTable.id),
      });
    });

    app.get('/api/assistant/conversations', requireGM, enabled, (req, res) => {
      res.json(listConversations(req.srTable));
    });

    app.post('/api/assistant/conversations', requireGM, enabled, (req, res) => {
      const c = createConversation(req.srTable, req.body?.title);
      res.json(viewConversation(c, req.srTable.state));
    });

    app.get('/api/assistant/conversations/:id', requireGM, enabled, (req, res) => {
      const c = getConversation(req.srTable, req.params.id);
      if (!c) return res.status(404).json(errorBody('Conversation introuvable'));
      res.json(viewConversation(c, req.srTable.state));
    });

    app.delete('/api/assistant/conversations/:id', requireGM, enabled, (req, res) => {
      if (isBusy(req.srTable.id)) return res.status(409).json(errorBody('L’assistant est en train de répondre'));
      if (!deleteConversation(req.srTable, req.params.id)) return res.status(404).json(errorBody('Conversation introuvable'));
      res.json({ ok: true });
    });

    // Ask a question. Answers immediately with the conversation id; the answer streams over the GM's socket
    // (assistant:delta / assistant:step / assistant:done), then the client reloads the conversation.
    app.post('/api/assistant/ask', requireGM, enabled, (req, res) => {
      const t = req.srTable;
      const text = String(req.body?.text || '').trim();
      if (!text) return res.status(400).json(errorBody('Question vide'));
      if (text.length > MAX_QUESTION) return res.status(400).json(errorBody('Question trop longue ({max} caractères max)', { max: MAX_QUESTION }));
      if (isBusy(t.id)) return res.status(409).json(errorBody('L’assistant est en train de répondre'));
      if (!authMode()) return res.status(503).json(errorBody('L’assistant n’est pas connecté à l’API Claude (voir /admin).'));
      const b = budgetStatus();
      if (!b.allowed) return res.status(402).json(errorBody('Budget mensuel de l’assistant atteint ({cap} $).', { cap: b.cap }));
      let c = req.body?.conversationId ? getConversation(t, String(req.body.conversationId)) : null;
      if (req.body?.conversationId && !c) return res.status(404).json(errorBody('Conversation introuvable'));
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
        simulate: (type, payload, state) => simulateAction(t, user, type, payload, state ?? undefined),
        emit: (event, data) => emitTo('gm', event, data),
      });
    });

    app.post('/api/assistant/stop', requireGM, enabled, (req, res) => {
      res.json({ stopped: stop(req.srTable.id) });
    });

    // Apply a proposal: re-build its actions from the CURRENT state and run them as the GM, in order.
    app.post('/api/assistant/proposals/:id/apply', requireGM, enabled, (req, res) => {
      const t = req.srTable;
      const found = findProposal(t, req.params.id);
      if (!found) return res.status(404).json(errorBody('Proposition introuvable'));
      const { proposal: p } = found;
      if (p.status === 'applied') return res.status(409).json(errorBody('Proposition déjà appliquée'));
      const built = buildOps(p.kind, p.input, t.state);
      if (built.error) {
        p.status = 'failed';
        p.error = built.error;
        save(t);
        return res.status(400).json(errorBody('Proposition impossible à appliquer : {reason}', { reason: built.error }));
      }
      const results = [];
      for (const op of built.ops) {
        const r = runAction(t, req.user, op.type, op.payload);
        if (!r.ok) {
          p.status = results.length ? 'partial' : 'failed';
          p.error = r.error;
          save(t);
          return res.status(400).json({ ...errorBody('Proposition impossible à appliquer : {reason}', { reason: r.error }), applied: results.length });
        }
        results.push(r.result);
      }
      p.status = 'applied';
      p.appliedAt = Date.now();
      p.error = undefined;
      const first = results[0];
      p.result = p.kind === 'map' ? { mapId: first } : p.kind === 'map_edits' ? { mapId: p.input.mapId } : p.kind === 'npc' ? { templateId: first?.templateId } : p.kind === 'handout' ? { handoutId: first } : {};
      save(t);
      res.json({ proposal: publicProposal(p) });
    });

    app.post('/api/assistant/proposals/:id/dismiss', requireGM, enabled, (req, res) => {
      const found = findProposal(req.srTable, req.params.id);
      if (!found) return res.status(404).json(errorBody('Proposition introuvable'));
      if (found.proposal.status === 'pending') found.proposal.status = 'dismissed';
      save(req.srTable);
      res.json({ proposal: publicProposal(found.proposal) });
    });
  },
};
