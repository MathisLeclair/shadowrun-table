// SINs and fake SINs (SR5 « Identification », p. 363-364; fake licenses p. 443). Pure rules shared by the server
// ('actor/sinCheck') and the sheet (ID cards, verification panel, log line).
//
// Checking a fake SIN: the verification system rolls Device Rating × 2 dice (Simple Test), threshold = the fake SIN's
// rating (or the checked fake license's rating). Hits under the threshold: no problem. Threshold reached but not
// exceeded: the SIN looks « odd », the operator is told to investigate. Threshold exceeded: reported as false — the SIN
// is burned and every later use fails automatically.

import type { Sin, SinCheckInfo } from './types.ts';

/** Outcome of a check ('real': a legal SIN, never checked). */
export type SinOutcome = SinCheckInfo['outcome'] | 'real';
/** The SIN fields the rules read. */
export type SinLike = Partial<Pick<Sin, 'id' | 'name' | 'rating' | 'licenses' | 'real'>>;
/** A license of a SIN: name and rating. */
export interface SinLicense {
  name: string;
  rating: number;
}

const tk = (s: string): string => s; // French keys for the i18n checker; the client renders them with t()

export const MAX_DEVICE_RATING = 6;

/** Fake SIN Details table (p. 363), paraphrased: what an identity of each rating holds up to. */
export const FAKE_SIN_DETAILS: Record<number, string> = {
  1: tk('N’importe qui : âge, sexe ou nationalité peuvent ne pas coller, aucune donnée annexe'),
  2: tk('Ressemblance grossière : le sexe colle, l’âge et la nationalité à peu près, aucune donnée annexe'),
  3: tk('Bonne ressemblance : sexe, âge et nationalité corrects, données annexes visiblement fausses'),
  4: tk('Plausible au premier coup d’œil : les données annexes passent un contrôle rapide'),
  5: tk('Bon profil : tout colle, biométrie valide d’une autre personne, un peu d’historique'),
  6: tk('Vie de rechange : biométrie avec échantillons, historique complet et crédible'),
};

/** SIN Verification Details table (p. 364), paraphrased: what a system of each rating checks. */
export const VERIFICATION_DETAILS: Record<number, string> = {
  1: tk('As-tu un SIN ?'),
  2: tk('Cohérence du numéro et de l’état civil'),
  3: tk('Cohérence + recherche des données externes liées au SIN'),
  4: tk('État civil vérifié, données externes recoupées, biométrie exigée'),
  5: tk('Vérification complète, biométrie comparée à un échantillon'),
  6: tk('Tout est vérifié : plusieurs échantillons biométriques, données annexes recoupées'),
};

/** Short tag of each outcome (log line, card stamp). */
export const OUTCOME_LABELS: Record<SinOutcome, string> = {
  pass: tk('Accepté'),
  odd: tk('Anomalie'),
  burned: tk('Grillé'),
  auto: tk('Grillé'),
  real: tk('Accepté'),
};

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** A real (legal) SIN: never fails a check. Imported data has no flag → every SIN is a fake unless marked `real`. */
export const isRealSin = (sin: SinLike | null | undefined): boolean => !!sin?.real;

/** Fake SIN rating 1-6 (0 = unknown / not set). */
export function sinRating(sin: SinLike | null | undefined): number {
  const n = Math.round(Number(sin?.rating) || 0);
  return clamp(n, 0, 6);
}

/** « Faux SIN — Jane Beauty » → « Jane Beauty » (the identity's name shown on the card). */
export function sinIdentity(sin: SinLike | null | undefined): string {
  const s = String(sin?.name || '').trim();
  return s.replace(/^(faux\s+sin|fake\s+sin|sin)\s*[—–:-]\s*/i, '').replace(/^fake\s+sin\s*\((.*)\)$/i, '$1').trim() || s;
}

/**
 * A license string as stored (« Driver's License (4) », « Port d’arme ») → { name, rating }.
 * Without a « (n) » the license has the SIN's rating (Chummer and the shop sell them at the same rating).
 */
export function parseLicense(text: unknown, sin?: SinLike | null): SinLicense {
  const s = String(text || '').trim();
  const m = /^(.*?)\s*\((\d+)\)\s*$/.exec(s);
  const rating = m ? clamp(Number(m[2]) || 0, 0, 6) : sinRating(sin);
  return { name: (m ? m[1] : s).trim() || s, rating };
}

export const sinLicenses = (sin: SinLike | null | undefined): SinLicense[] => (Array.isArray(sin?.licenses) ? sin.licenses : []).filter((l) => String(l || '').trim()).map((l) => parseLicense(l, sin));

/** Outcome of a check: hits < threshold → 'pass'; = threshold → 'odd'; > threshold → 'burned'. */
export function sinCheckOutcome(hits: unknown, threshold: unknown): 'pass' | 'odd' | 'burned' {
  const h = Number(hits) || 0;
  const th = Number(threshold) || 0;
  if (h < th) return 'pass';
  if (h === th) return 'odd';
  return 'burned';
}

/**
 * Odds of a check (each die hits on 5-6): { pass, odd, burned } as fractions of 1, for `pool` dice against `threshold`.
 */
export function checkOdds(pool: unknown, threshold: unknown): { pass: number; odd: number; burned: number } {
  const n = Math.max(0, Math.round(Number(pool) || 0));
  const th = Math.max(0, Math.round(Number(threshold) || 0));
  const p = 1 / 3;
  let c = 1; // C(n, k)
  let pass = 0;
  let odd = 0;
  for (let k = 0; k <= n; k++) {
    if (k > 0) c = (c * (n - k + 1)) / k;
    const pk = c * p ** k * (1 - p) ** (n - k);
    if (k < th) pass += pk;
    else if (k === th) odd += pk;
  }
  return { pass, odd, burned: Math.max(0, 1 - pass - odd) };
}

/** Dice of a verification system of that rating (Device Rating × 2). */
export const verificationPool = (device: unknown): number => clamp(Math.round(Number(device) || 0), 1, MAX_DEVICE_RATING) * 2;

/**
 * Decorative SIN number, stable for an item id (« SIN 4417-0952-83KD-7Q »). Purely flavor: nothing reads it back.
 */
export function sinNumber(sin: SinLike | null | undefined): string {
  const seed = String(sin?.id || sin?.name || 'sin');
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  const next = () => (h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0, h ^= h >>> 13, h >>> 0);
  const digits = (n: number) => Array.from({ length: n }, () => next() % 10).join('');
  const alnum = (n: number) => Array.from({ length: n }, () => '0123456789ACDEFHJKLMNPQRTUVWXY'[next() % 30]).join('');
  return `${digits(4)}-${digits(4)}-${digits(2)}${alnum(2)}-${alnum(2)}`;
}
