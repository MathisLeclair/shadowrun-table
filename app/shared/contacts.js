// Contacts (SR5 « Contacts », p. 386-389): rating tables, fees, and the contact's own stats when an NPC actor or a
// bestiary template has the contact's name. Pure; used by the shop (contact searches), 'actor/contactRoll' and the sheet.
//
// Rolls with a contact (p. 387-389):
// - reach: the GM may roll 2D6 — the contact is available if the roll ≥ their Connection (busier when influential);
// - negotiate: the runner's Negotiation + Charisma [Social] with the contact's Loyalty as extra dice (share confidential
//   info, haggle a business service, a favor above their Loyalty); 100 × (7 − Loyalty) ¥ buys one extra die (legwork);
// - legwork: the contact asks around — Extended Connection + Charisma [Social] Test, interval 1 hour;
// - network: the contact arranges a meeting — Etiquette + Charisma [Social] + Connection dice, threshold = target's Connection.
import { skillPool, derive, attr } from './sr5.js';

const tk = (s) => s; // French keys for the i18n checker; the client renders them with t()

export const MAX_CONNECTION = 12;
export const MAX_LOYALTY = 6;

/** Connection Rating Table (p. 387), paraphrased. */
export const CONNECTION_DETAILS = {
  1: tk('Aucune influence : on l’appelle pour ce qu’il sait'),
  2: tk('Un ou deux amis qui savent des choses, une influence minime'),
  3: tk('Quelques amis, mais peu d’influence'),
  4: tk('Connu dans tout un quartier : chef de gang, maire d’arrondissement'),
  5: tk('Influence modérée : conseiller municipal, petit cadre d’une corpo moyenne'),
  6: tk('Connu dans tout l’État : maire, fixer réputé, cadre moyen d’une corpo moyenne'),
  7: tk('Connu sur une large zone : dirigeant dans une corpo nationale'),
  8: tk('Bien placé sur plusieurs États : cadre d’un gouvernement d’État ou d’une corpo nationale'),
  9: tk('Bien placé sur tout le continent : cadre moyen d’une corpo AA'),
  10: tk('Réseau mondial : cadre supérieur d’une corpo AA ou d’un petit État'),
  11: tk('Réseau mondial très dense : cadre d’une corpo AAA ou d’une grande nation'),
  12: tk('Puissance mondiale : poste clé dans une corpo AAA ou une grande nation'),
};

/** Loyalty Rating Table (p. 387), paraphrased: level name + what the contact will do. */
export const LOYALTY_LEVELS = {
  1: { name: tk('Business'), text: tk('Purement mercenaire, aucun traitement de faveur') },
  2: { name: tk('Habitué'), text: tk('Toujours du business, mais avec un minimum de respect') },
  3: { name: tk('loyauté::Connaissance'), text: tk('Amical, rend de petits services, ne plongera pas pour toi') },
  4: { name: tk('Pote'), text: tk('Une vraie amitié : fera un détour pour t’aider') },
  5: { name: tk('Couvre tes arrières'), text: tk('Confiance de longue date : te soutient même quand c’est risqué') },
  6: { name: tk('Ami pour la vie'), text: tk('Ira jusqu’au bout pour toi, et toi pour lui') },
};

/** Favor Rating Table (p. 389), paraphrased examples. A contact agrees to a favor rated ≤ their Loyalty. */
export const FAVOR_RATINGS = {
  1: { name: tk('Mineur'), text: tk('Passer un message, accès à une zone peu sécurisée') },
  2: { name: tk('Risque faible'), text: tk('Prêt de matériel (≤ 5 000 ¥), signature d’un chef d’équipe') },
  3: { name: tk('Moyen'), text: tk('Accès à une zone moyennement sécurisée (labo corpo standard)') },
  4: { name: tk('Risque modéré'), text: tk('Prêt de matériel (≤ 50 000 ¥), signature d’un cadre moyen') },
  5: { name: tk('Sérieux'), text: tk('Accès à une zone de haute sécurité (siège AA, bureaux fédéraux)') },
  6: { name: tk('Risque majeur'), text: tk('Prêt de matériel (≤ 500 000 ¥), signature d’un cadre supérieur') },
};

export const ROLL_KINDS = ['reach', 'negotiate', 'legwork', 'network'];

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const int = (v, lo, hi) => clamp(Math.round(Number(v) || 0), lo, hi);
/** Lowercase, accent-free (same as shop/rules.js fold). */
export const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export const connectionOf = (c) => int(c?.connection, 0, MAX_CONNECTION);
export const loyaltyOf = (c) => int(c?.loyalty, 0, MAX_LOYALTY);

/** « Favor for a Friend » (p. 389): Connection × 100 ¥ for info, up to × 1 000 ¥ for goods / services, minus Loyalty × 10 % if you're nice. */
export function contactFees(c) {
  const cn = connectionOf(c);
  return { info: cn * 100, goods: cn * 1000, discountPct: loyaltyOf(c) * 10 };
}

/** Nuyen for `dice` extra dice on a Negotiation test to make the contact share (100 × (7 − Loyalty) ¥ per die, p. 388). */
export const bribeCost = (c, dice) => Math.max(0, Math.round(Number(dice) || 0)) * 100 * (7 - clamp(loyaltyOf(c) || 1, 1, 6));

/** 2D6 availability roll: available when the total ≥ Connection. */
export const reachable = (total, c) => Number(total) >= connectionOf(c);

/**
 * The contact's own stats: an NPC actor, else a bestiary template, whose name matches (accent / case-insensitive).
 * state = { actors, bestiary } (server state or the GM's view). Without one, `known: false` (only Connection / Loyalty).
 */
export function contactSheet(state, contact) {
  const connection = connectionOf(contact);
  const base = { id: contact.id, name: contact.name, connection, known: false };
  const key = fold(contact.name);
  if (!key) return base;
  const npc = Object.values(state?.actors || {}).find((a) => a && a.type === 'npc' && fold(a.name) === key);
  const src = npc || Object.values(state?.bestiary || {}).find((tp) => tp && fold(tp.name) === key);
  const portrait = src?.portrait || '';
  if (!src?.attributes) return portrait ? { ...base, portrait } : base;
  const sk = (src.skills || []).find((s) => s && (s.id === 'negotiation' || fold(s.name) === 'negociation'));
  const neg = skillPool(src, 'negotiation');
  const eti = skillPool(src, 'etiquette');
  const social = derive(src).limits.social;
  return {
    ...base, known: true, source: src.name, ...(portrait ? { portrait } : {}), ...(src.color ? { color: src.color } : {}),
    cha: attr(src, 'CHA'), negotiation: Number(sk?.rating) || 0, pool: neg.pool, defaulting: !!neg.defaulting,
    etiquette: eti.pool, etiquetteDefaulting: !!eti.defaulting, social, limit: social + connection,
  };
}
