// GM assistant — conversations and proposals of one table, in tables/<id>/assistant.json.
// Kept out of the game state on purpose: it is never broadcast and never reaches a player's view.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../../store.ts';
import { uid } from '../../../shared/util.ts';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { I18nParams } from '../../../shared/types.ts';
import type { Table } from '../tables.ts';

/** Input of a tool call, as written by the model (foreign data: validated by the tools and the actions). */
export type ToolInput = Record<string, any>;
export type ProposalKind = 'map' | 'map_edits' | 'npc' | 'handout' | 'campaign';
export type ProposalStatus = 'pending' | 'applied' | 'partial' | 'failed' | 'dismissed';
/** What a proposal card shows before it is applied (see runPropose in tools.ts). */
export interface ProposalPreview {
  map?: unknown;
  before?: string;
  template?: unknown;
  body?: string;
  text?: string;
  phases?: unknown[];
}
/** A change the model proposed; the GM applies it with one click (95-assistant). */
export interface Proposal {
  id: string;
  kind: ProposalKind;
  /** Campaign entry kind (quest, thread, session_plan, gm_notes). */
  sub?: string;
  title: string;
  input: ToolInput;
  preview: ProposalPreview;
  status: ProposalStatus;
  toolUseId: string;
  createdAt: number;
  appliedAt?: number;
  error?: string;
  result?: Record<string, unknown>;
}
/** A line the server adds to the chat (errors, warnings), shown before message `at`. */
export interface Notice {
  at: number;
  ts: number;
  kind: 'info' | 'warn' | 'error';
  /** French text (i18n key, translated by the client). */
  key: string;
  params?: I18nParams | null;
}
export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  usd: number;
  /** Raw API messages (never sent to the client as is). */
  messages: BetaMessageParam[];
  proposals: Record<string, Proposal>;
  notices: Notice[];
}
/** tables/<id>/assistant.json */
interface AssistantFile {
  conversations: Record<string, Conversation>;
}
/** The parts of a Table this file uses. */
type TableRef = Pick<Table, 'dir' | 'id'>;
export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  usd: number;
  pending: number;
}

const MAX_CONVERSATIONS = 40;
const cache = new Map<string, AssistantFile>(); // table dir -> data

const fileOf = (table: TableRef): string => path.join(table.dir, 'assistant.json');

function load(table: TableRef): AssistantFile {
  const key = table.dir;
  if (!cache.has(key)) {
    const raw = readJson(fileOf(table), null);
    cache.set(key, raw && typeof raw === 'object' && raw.conversations && typeof raw.conversations === 'object' ? raw : { conversations: {} });
  }
  return cache.get(key)!;
}

export function save(table: TableRef): void {
  try {
    fs.mkdirSync(table.dir, { recursive: true });
    writeJsonAtomic(fileOf(table), load(table));
  } catch (err) {
    console.error(`[assistant] write failed for ${table.id}`, err);
  }
}

export function listConversations(table: TableRef): ConversationSummary[] {
  return Object.values(load(table).conversations)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, usd: c.usd || 0, pending: Object.values(c.proposals || {}).filter((p) => p.status === 'pending').length }));
}

export function getConversation(table: TableRef, id: string): Conversation | null {
  return load(table).conversations[id] || null;
}

export function createConversation(table: TableRef, title?: unknown): Conversation {
  const data = load(table);
  const now = Date.now();
  const c: Conversation = { id: uid('conv'), title: String(title || 'New conversation').slice(0, 80), createdAt: now, updatedAt: now, usd: 0, messages: [], proposals: {}, notices: [] };
  data.conversations[c.id] = c;
  // Drop the oldest conversations beyond the limit.
  const all = Object.values(data.conversations).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const old of all.slice(MAX_CONVERSATIONS)) delete data.conversations[old.id];
  save(table);
  return c;
}

export function deleteConversation(table: TableRef, id: string): boolean {
  const data = load(table);
  if (!data.conversations[id]) return false;
  delete data.conversations[id];
  save(table);
  return true;
}

export function findProposal(table: TableRef, proposalId: string): { conversation: Conversation; proposal: Proposal } | null {
  for (const c of Object.values(load(table).conversations)) {
    const p = c.proposals?.[proposalId];
    if (p) return { conversation: c, proposal: p };
  }
  return null;
}

/** Test hook. */
export function _resetConversationCache(): void {
  cache.clear();
}
