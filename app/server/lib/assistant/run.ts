// GM assistant — one question → streamed answer, with a bounded tool loop and spend accounting after every call.
import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaMessage, BetaMessageStreamParams, BetaToolResultBlockParam, BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { MODELS, getSettings } from './config.ts';
import { budgetStatus, record, priceOf, costOf } from './budget.ts';
import { getClient, authMode, markCallOk } from './auth.ts';
import { buildSystem } from './context.ts';
import { TOOL_DEFS, PROPOSE_TOOLS, runTool, toolLabel } from './tools.ts';
import type { SimulateFn, ToolEnv, ToolLabel } from './tools.ts';
import { save } from './conversations.ts';
import type { Conversation, Notice, Proposal } from './conversations.ts';
import type { I18nParams, Lang, ServerEvents, TableState } from '../../../shared/types.ts';
import type { Table } from '../tables.ts';

type AssistantEvent = 'assistant:step' | 'assistant:delta' | 'assistant:done';
/** Sends an assistant event to the table's GM(s). */
export type EmitFn = <E extends AssistantEvent>(event: E, data: ServerEvents[E]) => void;
export interface RunTurnOptions {
  table: Table;
  conversation: Conversation;
  text: string;
  lang: Lang | string;
  simulate: SimulateFn;
  emit: EmitFn;
}
/** A proposal as the client sees it (without the raw tool input). */
export type PublicProposal = Omit<Proposal, 'input' | 'toolUseId'>;
/** One line of the GM's chat. */
export type ChatItem =
  | ({ type: 'notice' } & Partial<Notice> & { kind: Notice['kind']; key: string })
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'proposal'; proposal: PublicProposal }
  | ({ type: 'tool'; name: string } & ToolLabel);
export interface ConversationView {
  id: string;
  title: string;
  usd: number;
  createdAt: number;
  updatedAt: number;
  items: ChatItem[];
}

/** Marks a stored French key for tools/i18n-check.ts (translated by the client). */
const tk = (s: string): string => s;

export const MAX_STEPS = 8; // API calls per question
const MAX_TOKENS = 32000;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const running = new Map<string, AbortController>(); // table id -> AbortController

export const isBusy = (tableId: string): boolean => running.has(tableId);
export function stop(tableId: string): boolean {
  const ac = running.get(tableId);
  if (ac) ac.abort();
  return !!ac;
}

/** One line of live context on each question (not cached: it changes). */
function tableLine(state: TableState, lang: string): string {
  const map = state.maps?.[state.scene?.activeMapId as string];
  const c = state.combat;
  const next = (state.campaign?.sessions || []).find((s) => !s.played);
  const parts = [
    `Date réelle : ${new Date().toISOString().slice(0, 10)}`,
    `langue de l'interface du MJ : ${lang === 'en' ? 'anglais' : 'français'}`,
    `carte vue par les joueurs : ${map ? `« ${map.name} » (${map.id})` : 'aucune'}`,
    `combat : ${c?.active ? `en cours, round ${c.round}, passe ${c.pass}` : 'non'}`,
    next ? `prochaine séance non jouée : n°${next.number} « ${next.title} » (${next.id})` : null,
  ].filter(Boolean);
  return `[État de la table — ${parts.join(' · ')}]`;
}

/** Cost of a response; when a fallback model answered, price at the more expensive of the two (never under-count). */
function priceResponse(message: BetaMessage, requested: string): { cost: number; model: string } {
  const served = message.model || requested;
  if (served === requested) return { cost: costOf(message.usage, requested), model: requested };
  const a = costOf(message.usage, requested), b = costOf(message.usage, served);
  return a >= b ? { cost: a, model: requested } : { cost: b, model: served };
}

/**
 * Run one GM question in a conversation. Resolves when the turn is over (never rejects).
 * opts: { table, conversation, text, lang, simulate(type, payload, state?), emit(event, data) }
 */
export async function runTurn({ table, conversation, text, lang, simulate, emit }: RunTurnOptions): Promise<void> {
  const settings = getSettings();
  const model = settings.model;
  const info = MODELS[model];
  const convId = conversation.id;
  const notice = (key: string, params: I18nParams | null, kind: Notice['kind'] = 'info'): void => {
    conversation.notices.push({ at: conversation.messages.length, ts: Date.now(), kind, key, params });
  };

  const client = getClient();
  if (!client) {
    notice(tk('The assistant is not connected to the Claude API (see /admin).'), null, 'error');
    save(table);
    return emit('assistant:done', { conversationId: convId });
  }
  if (!budgetStatus().allowed) {
    notice(tk('The assistant\'s monthly budget is used up (${cap}).'), { cap: settings.monthlyCapUsd }, 'error');
    save(table);
    return emit('assistant:done', { conversationId: convId });
  }

  const ac = new AbortController();
  running.set(table.id, ac);
  const state = table.state;
  conversation.messages.push({ role: 'user', content: [{ type: 'text', text: tableLine(state, lang) }, { type: 'text', text }] });
  if (conversation.messages.length === 1) conversation.title = text.replace(/\s+/g, ' ').slice(0, 60);
  conversation.updatedAt = Date.now();
  save(table);

  try {
    const { system } = buildSystem({ docsDir: table.docsDir(), campaignName: state.config?.campaignName });
    let retries = 0;
    for (let step = 0; step < MAX_STEPS; step++) {
      if (step > 0 && !budgetStatus().allowed) {
        notice(tk('The assistant\'s monthly budget is used up (${cap}).'), { cap: settings.monthlyCapUsd }, 'error');
        break;
      }
      // Request fields of the beta API (refusal fallbacks are added below for the models that support them).
      const params: BetaMessageStreamParams = {
        model,
        max_tokens: MAX_TOKENS,
        system,
        tools: TOOL_DEFS,
        messages: conversation.messages,
        thinking: { type: 'adaptive' },
        output_config: { effort: settings.effort },
        cache_control: { type: 'ephemeral', ttl: '1h' },
      };
      if (info?.fallbacks) {
        params.betas = [FALLBACK_BETA];
        params.fallbacks = 'default';
      }
      emit('assistant:step', { conversationId: convId, phase: 'thinking' });
      const stream = client.beta.messages.stream(params, { signal: ac.signal });
      stream.on('text', (delta) => emit('assistant:delta', { conversationId: convId, text: delta }));
      let message: BetaMessage;
      try {
        message = await stream.finalMessage();
        retries = 0;
      } catch (err) {
        // Unparseable tool input or a dropped connection: re-issue the same turn (API errors are not retried here).
        if (err instanceof Anthropic.APIUserAbortError || ac.signal.aborted) throw err;
        if (err instanceof Anthropic.APIError || retries++ >= 2) throw err;
        step--;
        continue;
      }
      markCallOk();
      const { cost, model: billed } = priceResponse(message, model);
      record({ usage: message.usage, model: billed, tableId: table.id });
      conversation.usd = Math.round(((conversation.usd || 0) + cost) * 1e6) / 1e6;
      conversation.messages.push({ role: 'assistant', content: message.content });
      conversation.updatedAt = Date.now();
      save(table);
      emit('assistant:step', { conversationId: convId, phase: 'message' });

      if (message.stop_reason === 'refusal') {
        notice(tk('Claude declined to answer this request.'), null, 'error');
        break;
      }
      if (message.stop_reason === 'pause_turn') continue;
      const toolUses = message.content.filter((b): b is BetaToolUseBlock => b.type === 'tool_use');
      if (!toolUses.length) {
        if (message.stop_reason === 'max_tokens') notice(tk('Answer cut off (maximum length reached).'), null, 'warn');
        break;
      }
      const truncated = message.stop_reason === 'max_tokens';
      const results: BetaToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        if (truncated) {
          results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: 'Entrée coupée (longueur maximale atteinte) : recommence en plus petit (carte plus petite, moins d’éléments).' });
          continue;
        }
        const env: ToolEnv = {
          state: table.state,
          docsDir: table.docsDir(),
          simulate,
          toolUseId: tu.id,
          addProposal: (p) => {
            conversation.proposals[p.id] = p;
          },
        };
        const r = runTool(tu.name, tu.input, env);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: r.content, ...(r.isError ? { is_error: true } : {}) });
      }
      conversation.messages.push({ role: 'user', content: results });
      save(table);
      emit('assistant:step', { conversationId: convId, phase: 'tools' });
      if (step === MAX_STEPS - 1) notice(tk('Step limit reached for this question: ask again if needed.'), null, 'warn');
    }
  } catch (err) {
    if (err instanceof Anthropic.APIUserAbortError || ac.signal.aborted) notice(tk('Stopped by the GM.'), null, 'warn');
    else if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      console.error('[assistant] auth error', err.status, err.message);
      notice(tk('Claude API access denied ({status}): check the setup in /admin.'), { status: err.status }, 'error');
    } else if (err instanceof Anthropic.RateLimitError) notice(tk('API rate limit reached: try again in a moment.'), null, 'error');
    else if (err instanceof Anthropic.APIError) {
      console.error('[assistant] API error', err.status, err.message);
      notice(tk('Claude API error ({status}): {message}'), { status: err.status ?? '?', message: String(err.message || '').slice(0, 300) }, 'error');
    } else {
      console.error('[assistant] run failed', err);
      notice(tk('Assistant error: {message}'), { message: String((err as Error)?.message || err).slice(0, 300) }, 'error');
    }
  } finally {
    running.delete(table.id);
    conversation.updatedAt = Date.now();
    save(table);
    emit('assistant:done', { conversationId: convId });
  }
}

/**
 * The conversation as the GM's chat shows it: questions, answers, tool badges, proposal cards, notices.
 * (The raw API messages stay on the server.)
 */
export function viewConversation(c: Conversation, state: TableState): ConversationView {
  const items: ChatItem[] = [];
  // `input` is the model's tool input (foreign data).
  const nameOf = (name: string, input: any): string | null => {
    if (name === 'get_actor') return state.actors?.[input?.id]?.name || input?.id;
    if (name === 'get_map') return state.maps?.[input?.id]?.name || input?.id;
    if (name === 'get_bestiary' && input?.id) return state.bestiary?.[input.id]?.name || input.id;
    return null;
  };
  const byTool = new Map(Object.values(c.proposals || {}).map((p) => [p.toolUseId, p]));
  const notices = [...(c.notices || [])];
  c.messages.forEach((m, i) => {
    while (notices.length && notices[0].at <= i) items.push({ type: 'notice', ...notices.shift()! });
    if (m.role === 'user') {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }];
      const texts = blocks.flatMap((b) => (b.type === 'text' ? [b] : []));
      if (texts.length) items.push({ type: 'user', text: texts[texts.length - 1].text });
      return;
    }
    // Assistant messages hold the response's content blocks (stored as received).
    for (const b of (m.content || []) as BetaMessage['content']) {
      if (b.type === 'text' && b.text.trim()) items.push({ type: 'assistant', text: b.text });
      else if (b.type === 'tool_use') {
        if (PROPOSE_TOOLS.has(b.name)) {
          const p = byTool.get(b.id);
          if (p) items.push({ type: 'proposal', proposal: publicProposal(p) });
        } else {
          const label = toolLabel(b.name, (b.input || {}) as Record<string, unknown>);
          const n = nameOf(b.name, b.input);
          if (n && label.params) label.params.name = n;
          items.push({ type: 'tool', name: b.name, ...label });
        }
      } else if (b.type === 'fallback') items.push({ type: 'notice', kind: 'info', key: tk('Answer provided by another model ({model}).'), params: { model: b.to?.model || '?' } });
    }
  });
  for (const n of notices) items.push({ type: 'notice', ...n });
  return { id: c.id, title: c.title, usd: Math.round((c.usd || 0) * 10000) / 10000, createdAt: c.createdAt, updatedAt: c.updatedAt, items };
}

export function publicProposal(p: Proposal): PublicProposal {
  const { input, toolUseId, ...rest } = p;
  return rest;
}

export { priceOf };
