// GM assistant — conversations and proposals of one table, in tables/<id>/assistant.json.
// Kept out of the game state on purpose: it is never broadcast and never reaches a player's view.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../../store.js';
import { uid } from '../../../shared/util.js';

const MAX_CONVERSATIONS = 40;
const cache = new Map(); // table dir -> data

const fileOf = (table) => path.join(table.dir, 'assistant.json');

function load(table) {
  const key = table.dir;
  if (!cache.has(key)) {
    const raw = readJson(fileOf(table), null);
    cache.set(key, raw && typeof raw === 'object' && raw.conversations && typeof raw.conversations === 'object' ? raw : { conversations: {} });
  }
  return cache.get(key);
}

export function save(table) {
  try {
    fs.mkdirSync(table.dir, { recursive: true });
    writeJsonAtomic(fileOf(table), load(table));
  } catch (err) {
    console.error(`[assistant] write failed for ${table.id}`, err);
  }
}

export function listConversations(table) {
  return Object.values(load(table).conversations)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, usd: c.usd || 0, pending: Object.values(c.proposals || {}).filter((p) => p.status === 'pending').length }));
}

export function getConversation(table, id) {
  return load(table).conversations[id] || null;
}

export function createConversation(table, title) {
  const data = load(table);
  const now = Date.now();
  const c = { id: uid('conv'), title: String(title || 'Nouvelle conversation').slice(0, 80), createdAt: now, updatedAt: now, usd: 0, messages: [], proposals: {}, notices: [] };
  data.conversations[c.id] = c;
  // Drop the oldest conversations beyond the limit.
  const all = Object.values(data.conversations).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const old of all.slice(MAX_CONVERSATIONS)) delete data.conversations[old.id];
  save(table);
  return c;
}

export function deleteConversation(table, id) {
  const data = load(table);
  if (!data.conversations[id]) return false;
  delete data.conversations[id];
  save(table);
  return true;
}

export function findProposal(table, proposalId) {
  for (const c of Object.values(load(table).conversations)) {
    const p = c.proposals?.[proposalId];
    if (p) return { conversation: c, proposal: p };
  }
  return null;
}

/** Test hook. */
export function _resetConversationCache() {
  cache.clear();
}
