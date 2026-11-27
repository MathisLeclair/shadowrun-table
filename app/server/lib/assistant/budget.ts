// GM assistant — spend ledger (runtime/assistant/usage.json), server-wide, one bucket per calendar month (UTC).
// Every API response's usage is priced and recorded; requests are refused once the month's spend reaches the cap.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../../store.ts';
import { ASSISTANT_DIR, MODELS, OTHER_PRICES, UNKNOWN_PRICE, getSettings } from './config.ts';
import type { Price } from './config.ts';

/** Token usage as reported by the API (fields of Anthropic's Usage / BetaUsage that we price). */
export interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
}
export interface MonthTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export interface MonthUsage {
  usd: number;
  calls: number;
  tokens: MonthTokens;
  /** table id ('?' when unknown, 'admin-test') -> spend */
  tables: Record<string, { usd: number; calls: number }>;
}
/** runtime/assistant/usage.json */
export interface Ledger {
  months: Record<string, MonthUsage>;
  resets?: { ts: number; month: string; usd: number }[];
}
export interface BudgetStatus {
  month: string;
  spent: number;
  cap: number;
  remaining: number;
  allowed: boolean;
  ratio: number;
}

const USAGE_FILE = () => path.join(ASSISTANT_DIR, 'usage.json');
/** Kept free under the cap so one more call (big context + max output) cannot overshoot it much. */
export const RESERVE_USD = 0.5;

export const monthKey = (ts: number = Date.now()): string => new Date(ts).toISOString().slice(0, 7); // "2026-11"

let ledger: Ledger | null = null;
function load(): Ledger {
  if (!ledger) {
    const raw = readJson(USAGE_FILE(), null);
    ledger = raw && typeof raw === 'object' && raw.months && typeof raw.months === 'object' ? raw : { months: {} };
  }
  return ledger!;
}
function save(): void {
  try {
    fs.mkdirSync(ASSISTANT_DIR, { recursive: true });
    writeJsonAtomic(USAGE_FILE(), ledger);
  } catch (err) {
    console.error('[assistant] usage ledger write failed', err);
  }
}

export function priceOf(model: string): Price {
  return MODELS[model] || OTHER_PRICES[model] || UNKNOWN_PRICE;
}

/**
 * USD cost of one response's usage. Cache writes are split by TTL when the API reports it,
 * otherwise priced at the 1-hour rate (what we request; never under-counts).
 */
export function costOf(usage: UsageLike = {}, model: string): number {
  const p = priceOf(model);
  const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const write = n(usage.cache_creation_input_tokens);
  const w5 = n(usage.cache_creation?.ephemeral_5m_input_tokens);
  const w1 = n(usage.cache_creation?.ephemeral_1h_input_tokens);
  const writeCost = w5 + w1 > 0 ? w5 * p.cacheWrite5m + w1 * p.cacheWrite1h + Math.max(0, write - w5 - w1) * p.cacheWrite1h : write * p.cacheWrite1h;
  const usd = (n(usage.input_tokens) * p.input + n(usage.cache_read_input_tokens) * p.cacheRead + writeCost + n(usage.output_tokens) * p.output) / 1e6;
  return Math.round(usd * 1e6) / 1e6;
}

/** Record one API call. Returns the cost in USD. */
export function record({ usage, model, tableId, ts = Date.now() }: { usage: UsageLike; model: string; tableId?: string | null; ts?: number }): number {
  const cost = costOf(usage, model);
  const l = load();
  const key = monthKey(ts);
  const m = (l.months[key] ||= { usd: 0, calls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tables: {} });
  m.usd = Math.round((m.usd + cost) * 1e6) / 1e6;
  m.calls += 1;
  m.tokens.input += usage?.input_tokens || 0;
  m.tokens.output += usage?.output_tokens || 0;
  m.tokens.cacheRead += usage?.cache_read_input_tokens || 0;
  m.tokens.cacheWrite += usage?.cache_creation_input_tokens || 0;
  const t = (m.tables[tableId || '?'] ||= { usd: 0, calls: 0 });
  t.usd = Math.round((t.usd + cost) * 1e6) / 1e6;
  t.calls += 1;
  save();
  return cost;
}

export function monthUsage(ts: number = Date.now()): MonthUsage {
  const m = load().months[monthKey(ts)];
  return m ? JSON.parse(JSON.stringify(m)) : { usd: 0, calls: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, tables: {} };
}

/** { spent, cap, remaining, allowed, ratio } for the current month. */
export function budgetStatus(ts: number = Date.now()): BudgetStatus {
  const cap = getSettings().monthlyCapUsd;
  const spent = monthUsage(ts).usd;
  return {
    month: monthKey(ts),
    spent: Math.round(spent * 100) / 100,
    cap,
    remaining: Math.max(0, Math.round((cap - spent) * 100) / 100),
    allowed: spent + RESERVE_USD <= cap,
    ratio: cap > 0 ? Math.min(1, spent / cap) : 1,
  };
}

/** Admin: zero the current month (e.g. after raising the Console limit). Keeps a note of what was cleared. */
export function resetMonth(ts: number = Date.now()): void {
  const l = load();
  const key = monthKey(ts);
  if (l.months[key]) {
    (l.resets ||= []).push({ ts, month: key, usd: l.months[key].usd });
    delete l.months[key];
    save();
  }
}

/** Test hook. */
export function _resetLedgerCache(): void {
  ledger = null;
}
