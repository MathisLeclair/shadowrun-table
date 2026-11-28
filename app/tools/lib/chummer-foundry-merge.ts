// Merge a character's old Chummer file with the version the app got from Foundry VTT (and may have edited since).
// Used by tools/migrate-chummer-foundry.ts. Pure: no server, no file access.
//
// The Chummer → Foundry conversion lost structure (ware grade and subsystems, nested gear, vehicle mods, languages,
// item guids), while Foundry holds what changed in play after the Chummer file was saved (karma, nuyen, raised
// ratings, new contacts and gear, used ammo). So:
// - the Chummer item gives the structure (catalog id, guid, source, nested entries, grade…);
// - the app item gives the play state (quantity, equipped, contact ratings, burned SIN…) and keeps its id, so the
//   Foundry link (`actor.foundry`) and anything pointing at the item still match;
// - Chummer-only items are restored, top-level ones with a « to check » note; app-only items (bought in play) stay;
// - karma, nuyen, attributes, skill ratings, condition: the app's; street cred is recomputed with the app's career karma.
// Lifestyles are always the app's (the rent is managed in the app): a Chummer-only lifestyle is not restored.
import type { Actor, ChummerLink, HistoryEntry } from '../../shared/types.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = Record<string, any>;

/** Lists merged item by item (skills and knowledge have their own rules). */
const LISTS = ['weapons', 'armor', 'augmentations', 'gear', 'vehicles', 'contacts', 'sins', 'qualities', 'powers', 'spells', 'complexForms', 'martialArts', 'lifestyles'];
/** Nested list of each list. */
const SUB: Record<string, string> = { weapons: 'accessories', armor: 'mods', vehicles: 'mods', lifestyles: 'qualities', martialArts: 'techniques' };
/** Fields that change in play: the app's value wins when it has one. */
const PLAY_KEYS = ['qty', 'equipped', 'active', 'disabled', 'wirelessOff', 'ammoLoaded', 'ammoType', 'connection', 'loyalty', 'burned', 'burnedAt', 'real', 'paid'];
/** Lists where the app always wins (whole item) and Chummer-only entries are not restored. */
const APP_LISTS = new Set(['lifestyles']);

export interface MergeOptions {
  /** Chummer link to store on the actor (parse result `actor.chummer`, xml included). */
  chummer: ChummerLink;
  /** Note appended to restored top-level items, e.g. « Restauré depuis Chummer (fichier du 01/08/2020) — à vérifier ». */
  note: string;
  /** History entry added to the actor. */
  history?: HistoryEntry;
  /** Paragraph appended to the GM notes (once). */
  gmNote?: string;
}

export interface MergeReport {
  matched: number;
  restored: string[];
  kept: string[];
  dropped: string[];
  scalars: string[];
}

const norm = (s: unknown): string =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[«»"“”’'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const bare = (s: unknown): string => norm(s).replace(/\s*\([^)]*\)\s*/g, ' ').replace(/^faux sin\s*[—-]\s*/, '').trim();
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** How sure we are that app item `a` (in list `al`) is Chummer item `c` (in list `cl`): 0 = not the same. */
function score(c: Rec, cl: string, a: Rec, al: string): number {
  if (c.chummerGuid && a.chummerGuid) return c.chummerGuid === a.chummerGuid ? 100 : 0;
  let s = 0;
  if (c.catalogId && a.catalogId && c.catalogId === a.catalogId) s = cl === al ? 50 : 40;
  else if (cl !== al) return 0;
  else if (norm(c.name) === norm(a.name)) s = 30;
  else if (c.choice && norm(a.name).includes(norm(c.choice))) s = 28;
  else if (bare(c.name) && bare(c.name) === bare(a.name)) s = 26;
  else if (norm(a.notes).startsWith(norm(c.name))) s = 25; // Foundry notes start with the English name
  else return 0;
  if (cl === 'contacts' || cl === 'knowledge') return s;
  if ((c.qty ?? 1) === (a.qty ?? 1)) s += 6;
  if (norm(c.name) === norm(a.name)) s += 3;
  if ((c.rating ?? null) === (a.rating ?? null)) s += 1;
  return s;
}

/** Nested entries: Chummer's (app id kept when matched) + the app's that Chummer does not have (restored / bought in the app). */
function mergeSubs(cs: Rec[] = [], as: Rec[] = []): Rec[] {
  const used = new Set<number>();
  const out = cs.map((c) => {
    const i = as.findIndex((a, k) => !used.has(k) && ((c.catalogId && a.catalogId === c.catalogId) || norm(a.name) === norm(c.name)));
    if (i < 0) return clone(c);
    used.add(i);
    return { ...clone(c), id: as[i].id };
  });
  as.forEach((a, k) => { if (!used.has(k)) out.push(clone(a)); });
  return out;
}

function mergeItem(c: Rec, a: Rec, list: string): Rec {
  if (APP_LISTS.has(list)) return { ...clone(a), ...(c.chummerGuid ? { chummerGuid: c.chummerGuid } : {}) };
  const out: Rec = { ...clone(c), id: a.id };
  for (const k of PLAY_KEYS) if (a[k] !== undefined && a[k] !== null) out[k] = a[k];
  if (list === 'gear' && a.rating !== undefined) out.rating = a.rating;
  if (SUB[list]) {
    const subs = mergeSubs(c[SUB[list]], a[SUB[list]]);
    if (subs.length) out[SUB[list]] = subs;
  }
  return out;
}

const isChild = (it: Rec): boolean => /^(dans|in) /i.test(String(it.notes || '')) || /Sous-système de|Subsystem of/i.test(String(it.notes || ''));
const withNote = (it: Rec, note: string): Rec => (String(it.notes || '').includes(note) ? it : { ...it, notes: it.notes ? `${it.notes}\n${note}` : note });

/**
 * Merge `chum` (the parsed Chummer file) into `app` (the actor as the app has it now). Returns a new actor; neither
 * input is changed.
 */
export function mergeChummerFoundry(app: Actor, chum: Rec, opts: MergeOptions): { actor: Actor; report: MergeReport } {
  const A = clone(app) as unknown as Rec;
  const C = chum;
  const report: MergeReport = { matched: 0, restored: [], kept: [], dropped: [], scalars: [] };

  // Identity texts the app does not have.
  for (const k of ['realName', 'metavariant', 'gender', 'age', 'player']) if ((A[k] === undefined || A[k] === '' || A[k] === null) && C[k]) A[k] = C[k];
  // Street cred: Chummer's value with the app's career karma (Foundry kept only the manual bonus).
  const street = (C.streetCred || 0) + Math.floor((A.karmaTotal || 0) / 10) - Math.floor((C.karmaTotal || 0) / 10);
  for (const [k, v] of [['streetCred', street], ['notoriety', C.notoriety || 0], ['publicAwareness', C.publicAwareness || 0]] as const) {
    if (v > (A[k] || 0)) { report.scalars.push(`${k} ${A[k] || 0} → ${v}`); A[k] = v; }
  }
  for (const k of ['vision', 'initiative']) if (C[k] && Object.keys(C[k]).length) A[k] = { ...C[k], ...(A[k] || {}) };
  if (C.matrix?.device) A.matrix = { ...(A.matrix || {}), device: C.matrix.device };
  for (const [k, v] of Object.entries<number>(C.attributes || {})) if (A.attributes?.[k] !== v) report.scalars.push(`${k} app ${A.attributes?.[k]} (Chummer ${v})`);

  // Skills: by id. App rating and specialization (newer), Chummer-only skills restored.
  const skills: Rec[] = (A.skills || []).map((s: Rec) => {
    const c = (C.skills || []).find((x: Rec) => x.id === s.id);
    return c ? { ...clone(c), ...s, ...(s.spec || c.spec ? { spec: s.spec || c.spec } : {}) } : s;
  });
  for (const c of C.skills || []) if (!skills.some((s) => s.id === c.id)) { skills.push(clone(c)); report.restored.push(`skill ${c.name} ${c.rating}`); }
  A.skills = skills;

  // Knowledge (and languages): by name.
  const know: Rec[] = [];
  const usedK = new Set<number>();
  for (const c of C.knowledge || []) {
    const i = (A.knowledge || []).findIndex((a: Rec, k: number) => !usedK.has(k) && score(c, 'knowledge', a, 'knowledge') > 0);
    if (i < 0) { know.push(clone(c)); report.restored.push(`knowledge ${c.name}`); continue; }
    usedK.add(i);
    const a = A.knowledge[i];
    know.push({ ...clone(c), id: a.id, rating: a.rating ?? c.rating, ...(a.spec || c.spec ? { spec: a.spec || c.spec } : {}) });
  }
  (A.knowledge || []).forEach((a: Rec, k: number) => { if (!usedK.has(k)) know.push(a); });
  A.knowledge = know;

  // Item lists: pairs ranked by score over every list (an item can sit in another list on each side, e.g. nice
  // clothes: Chummer armor, Foundry gear).
  const pairs: Array<{ s: number; cl: string; ci: number; al: string; ai: number }> = [];
  for (const cl of LISTS) (C[cl] || []).forEach((c: Rec, ci: number) => {
    for (const al of LISTS) (A[al] || []).forEach((a: Rec, ai: number) => {
      const s = score(c, cl, a, al);
      if (s > 0) pairs.push({ s, cl, ci, al, ai });
    });
  });
  pairs.sort((x, y) => y.s - x.s);
  const cUsed = new Map<string, Rec>(); // `${cl}:${ci}` → app item
  const aUsed = new Set<string>();
  for (const p of pairs) {
    const ck = `${p.cl}:${p.ci}`, ak = `${p.al}:${p.ai}`;
    if (cUsed.has(ck) || aUsed.has(ak)) continue;
    cUsed.set(ck, A[p.al][p.ai]);
    aUsed.add(ak);
  }
  const out: Record<string, Rec[]> = {};
  for (const cl of LISTS) {
    out[cl] = [];
    (C[cl] || []).forEach((c: Rec, ci: number) => {
      const a = cUsed.get(`${cl}:${ci}`);
      if (a) { out[cl].push(mergeItem(c, a, cl)); report.matched++; return; }
      if (APP_LISTS.has(cl)) { report.dropped.push(`${cl} ${c.name}`); return; }
      const sure = isChild(c) || (cl === 'gear' && c.name === C.matrix?.device); // the commlink is in actor.matrix too
      out[cl].push(sure ? clone(c) : withNote(clone(c), opts.note));
      report.restored.push(`${cl} ${c.name}${c.qty > 1 ? ` x${c.qty}` : ''}`);
    });
  }
  for (const al of LISTS) (A[al] || []).forEach((a: Rec, ai: number) => {
    if (aUsed.has(`${al}:${ai}`)) return;
    out[al].push(a);
    report.kept.push(`${al} ${a.name}${a.qty > 1 ? ` x${a.qty}` : ''}`);
  });
  for (const l of LISTS) if (out[l].length || Array.isArray(A[l])) A[l] = out[l];

  // Inventory locations Chummer items point at.
  if (Array.isArray(C.containers) && C.containers.length) {
    const have = new Set((A.containers || []).map((x: Rec) => x.id));
    A.containers = [...(A.containers || []), ...C.containers.filter((x: Rec) => !have.has(x.id))].map((ct: Rec) =>
      // A Chummer location named after one of the vehicles (« Roadmaster ») is that vehicle.
      ct.kind === 'other' && (A.vehicles || []).some((v: Rec) => norm(v.name).includes(norm(ct.name))) ? { ...ct, kind: 'vehicle' } : ct);
  }
  if (opts.gmNote && !String(A.gmNotes || '').includes(opts.gmNote)) A.gmNotes = A.gmNotes ? `${A.gmNotes}\n\n${opts.gmNote}` : opts.gmNote;
  A.chummer = opts.chummer;
  if (opts.history) A.history = [...(A.history || []), opts.history];
  return { actor: A as Actor, report };
}
