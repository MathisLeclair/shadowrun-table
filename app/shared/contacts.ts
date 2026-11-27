// Contacts (SR5 « Contacts », p. 386-389): rating tables, fees, and the contact's own stats when an NPC actor or a
// bestiary template has the contact's name. Pure; used by the shop (contact searches), 'actor/contactRoll' and the sheet.
//
// Rolls with a contact (p. 387-389):
// - reach: the GM may roll 2D6 — the contact is available if the roll ≥ their Connection (busier when influential);
// - negotiate: the runner's Negotiation + Charisma [Social] with the contact's Loyalty as extra dice (share confidential
//   info, haggle a business service, a favor above their Loyalty); 100 × (7 − Loyalty) ¥ buys one extra die (legwork);
// - legwork: the contact asks around — Extended Connection + Charisma [Social] Test, interval 1 hour;
// - network: the contact arranges a meeting — Etiquette + Charisma [Social] + Connection dice, threshold = target's Connection.
import { skillPool, derive, attr } from './sr5.ts';
import type { ActorLike, Contact, ContactRollInfo, ContactSheet } from './types.ts';

/** A level of LOYALTY_LEVELS / FAVOR_RATINGS: French keys. */
export interface RatingLevel {
  name: string;
  text: string;
}
export type ContactRollKind = ContactRollInfo['kind'];
/** The contact fields the rules read. */
export type ContactLike = Partial<Pick<Contact, 'id' | 'name' | 'connection' | 'loyalty'>>;
/** What contactSheet() searches: the server state or the GM's view (actors and bestiary, both optional). */
export interface ContactSheetSource {
  actors?: Record<string, ActorLike | null | undefined> | null;
  bestiary?: Record<string, ActorLike | null | undefined> | null;
}

const tk = (s: string): string => s; // French keys for the i18n checker; the client renders them with t()

export const MAX_CONNECTION = 12;
export const MAX_LOYALTY = 6;

/** Connection Rating Table (p. 387), paraphrased. */
export const CONNECTION_DETAILS: Record<number, string> = {
  1: tk('No influence: you call them for what they know'),
  2: tk('One or two friends who know things, minor influence'),
  3: tk('A few friends, but little influence'),
  4: tk('Known across a neighborhood: gang leader, borough mayor'),
  5: tk('Moderate influence: city councilman, low-level executive in a mid-size corp'),
  6: tk('Known across the state: mayor, notable fixer, mid-level executive in a mid-size corp'),
  7: tk('Known over a large area: leadership position in a national corp'),
  8: tk('Well connected across several states: executive in a state government or national corp'),
  9: tk('Well connected on the continent: mid-level executive in an AA megacorp'),
  10: tk('Worldwide network: senior executive in an AA megacorp or small nation'),
  11: tk('Extremely well connected worldwide: executive in a AAA megacorp or major nation'),
  12: tk('Global power player: key position in a AAA megacorp or major nation'),
};

/** Loyalty Rating Table (p. 387), paraphrased: level name + what the contact will do. */
export const LOYALTY_LEVELS: Record<number, RatingLevel> = {
  1: { name: tk('Just Biz'), text: tk('Purely mercenary, no preferential treatment') },
  2: { name: tk('Regular'), text: tk('Still business, but with some mutual respect') },
  3: { name: tk('loyalty::Acquaintance'), text: tk('Friendly, does small favors, won’t take a fall for you') },
  4: { name: tk('Buddy'), text: tk('Real friendship: will go out of their way for you') },
  5: { name: tk('Got Your Back'), text: tk('Long-standing trust: backs you even when it’s risky') },
  6: { name: tk('Friend for Life'), text: tk('Will go to the wall for you, and you for them') },
};

/** Favor Rating Table (p. 389), paraphrased examples. A contact agrees to a favor rated ≤ their Loyalty. */
export const FAVOR_RATINGS: Record<number, RatingLevel> = {
  1: { name: tk('Minor'), text: tk('Deliver a message, access to a low-security area') },
  2: { name: tk('Low Risk'), text: tk('Equipment loan (≤ 5,000¥), a supervisor’s signature') },
  3: { name: tk('Medium'), text: tk('Access to a mid-level security area (standard corp lab)') },
  4: { name: tk('Moderate Risk'), text: tk('Equipment loan (≤ 50,000¥), a middle manager’s signature') },
  5: { name: tk('Serious'), text: tk('Access to a high-security area (AA HQ, federal offices)') },
  6: { name: tk('Major Risk'), text: tk('Equipment loan (≤ 500,000¥), a senior manager’s signature') },
};

export const ROLL_KINDS: ContactRollKind[] = ['reach', 'negotiate', 'legwork', 'network'];

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
const int = (v: unknown, lo: number, hi: number): number => clamp(Math.round(Number(v) || 0), lo, hi);
/** Lowercase, accent-free (same as shop/rules.js fold). */
export const fold = (s: unknown): string => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export const connectionOf = (c: ContactLike | null | undefined): number => int(c?.connection, 0, MAX_CONNECTION);
export const loyaltyOf = (c: ContactLike | null | undefined): number => int(c?.loyalty, 0, MAX_LOYALTY);

/** « Favor for a Friend » (p. 389): Connection × 100 ¥ for info, up to × 1 000 ¥ for goods / services, minus Loyalty × 10 % if you're nice. */
export function contactFees(c: ContactLike | null | undefined): { info: number; goods: number; discountPct: number } {
  const cn = connectionOf(c);
  return { info: cn * 100, goods: cn * 1000, discountPct: loyaltyOf(c) * 10 };
}

/** Nuyen for `dice` extra dice on a Negotiation test to make the contact share (100 × (7 − Loyalty) ¥ per die, p. 388). */
export const bribeCost = (c: ContactLike | null | undefined, dice: unknown): number => Math.max(0, Math.round(Number(dice) || 0)) * 100 * (7 - clamp(loyaltyOf(c) || 1, 1, 6));

/** 2D6 availability roll: available when the total ≥ Connection. */
export const reachable = (total: unknown, c: ContactLike | null | undefined): boolean => Number(total) >= connectionOf(c);

/**
 * The contact's own stats: an NPC actor, else a bestiary template, whose name matches (accent / case-insensitive).
 * state = { actors, bestiary } (server state or the GM's view). Without one, `known: false` (only Connection / Loyalty).
 */
export function contactSheet(state: ContactSheetSource | null | undefined, contact: ContactLike): ContactSheet {
  const connection = connectionOf(contact);
  const base: ContactSheet = { id: contact.id as string, name: contact.name as string, connection, known: false };
  const key = fold(contact.name);
  if (!key) return base;
  const npc = Object.values(state?.actors || {}).find((a) => a && a.type === 'npc' && fold(a.name) === key);
  const src = npc || Object.values(state?.bestiary || {}).find((tp) => tp && fold(tp.name) === key);
  // src is an actor-shaped sheet (NPC actor or bestiary template)
  const portrait = src?.portrait || '';
  if (!src?.attributes) return portrait ? { ...base, portrait } : base;
  const sk = (src!.skills || []).find((s) => s && (s.id === 'negotiation' || fold(s.name) === 'negociation'));
  const neg = skillPool(src!, 'negotiation');
  const eti = skillPool(src, 'etiquette');
  const social = derive(src!).limits.social;
  return {
    ...base, known: true, source: src!.name ?? undefined, ...(portrait ? { portrait } : {}), ...(src!.color ? { color: src!.color } : {}),
    cha: attr(src, 'CHA'), negotiation: Number(sk?.rating) || 0, pool: neg.pool, defaulting: !!neg.defaulting,
    etiquette: eti.pool, etiquetteDefaulting: !!eti.defaulting, social, limit: social + connection,
  };
}
