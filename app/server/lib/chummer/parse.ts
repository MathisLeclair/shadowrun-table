// .chum5 (Chummer5a save file) → Actor (see ARCHITECTURE.md « Actors »).
// Every imported list item keeps `chummerGuid` (the <guid> of its node) and `catalogId` (= Chummer <sourceid>),
// which lets export.js patch the original file and the 3-way merge (merge.js) match items across versions.
import crypto from 'node:crypto';
import { parseXml, XmlError, type Element, type XmlDocument } from './xml.ts';
import { i18nError, errorParam, warningList } from './messages.ts';
import { t as translate, tn as translateN, SOURCE_LANG } from '../i18n.ts';
import { skillsData, appSkillId, metatypeData, METATYPE_FROM_EN, frenchName, frenchCategory, gradeTable, norm, appCatalog, findDataItem, type DataKind } from './data.ts';
import { SKILL_BY_ID } from '../../../shared/sr5.ts';
import { blankActor, categoryToSkill, evalFormula, MELEE_SKILLS, LIFESTYLE_BASES } from '../../../client/modules/sheet/sheet-data.ts';
import { monthlyCost } from '../../../shared/lifestyle.ts';
import { uid } from '../../../shared/util.ts';
import { chummerTradition } from '../traditions.ts';
import { guessContainerKind, ammoKindOf, isThrownExplosive, parseAmmo } from '../../../client/modules/sheet/inventory.ts';
import type {
  Accessory, Actor, AmmoKind, ArmorMod, Augmentation, AttrKey, Container, ContainerKind, I18nMessage, I18nParams, ItemBase, KnowledgeSkill, KnowledgeType, Lang, Lifestyle,
  LifestyleQuality, MountPoint, VehicleMod, Weapon,
} from '../../../shared/types.ts';

/** Item id factory: makeId('itm') → 'itm_…'. */
export type MakeId = (prefix: string) => string;
/** A parsed actor: the Actor without its id (the caller gives it one). */
export type ParsedActor = Omit<Actor, 'id'> & { id?: string };
/** parseChum5() options. */
export interface ParseOptions {
  fileName?: string;
  now?: number;
  makeId?: MakeId;
  keepXml?: boolean;
  /**
   * Language of the texts the parser writes into the actor (default name, notes, bio headings): the table language for a
   * new import, the actor's `chummer.lang` when re-parsing for a merge or an export (same texts on both sides). Default: English.
   */
  lang?: Lang;
}
/** parseChum5() result. */
export interface ParseResult {
  actor: ParsedActor;
  warnings: string[];
  warningsI18n: I18nMessage[];
  info: { created: boolean; appVersion: string; buildMethod: string; mugshot: string | null };
}
/** An enabled <improvement> of the file. */
interface Improvement {
  type: string;
  name: string;
  val: number;
  aug: number;
  source: string;
}
/** Head of a nested item (subHead()). */
interface SubHead {
  id: string;
  name: string;
  nameFr?: string;
  catalogId?: string;
  chummerGuid?: string;
  source?: string;
  page?: number;
}
/** Chummer locations → containers (locationsOf()). */
interface Locations {
  containers: Container[];
  resolve(v: unknown): string | undefined;
}
/** Lifestyle while parsing: `_tenant` (Chummer primary tenant) is removed before returning. */
type TenantLifestyle = Lifestyle & { _tenant?: boolean };

/** User-facing import error (English message + i18n key, no stack needed). */
export class ChummerError extends Error {}

/** Marks an English key for tools/i18n-check.ts (rendered with the parse language). */
const tk = (s: string): string => s;
/** First part of an enemy contact's notes (export.ts strips it back: « ENEMY », « ENNEMI » on French tables). */
export const ENEMY_NOTE = tk('ENEMY');

export const APP_ATTRS: AttrKey[] = ['BOD', 'AGI', 'REA', 'STR', 'WIL', 'LOG', 'INT', 'CHA', 'EDG', 'MAG', 'RES'];
const KNO_TYPES: Record<string, KnowledgeType> = { street: 'street', academic: 'academic', professional: 'professional', interest: 'interest', language: 'language' };
const MATRIX_CATS = /^(Commlinks?|Cyberdecks?|Rigger Command Consoles?|Cyberterminals?)$/i;
const PROGRAM_CATS = /programs?$/i;

const num = (s: unknown, d = 0): number => {
  const n = Number(String(s ?? '').trim().replace(',', '.'));
  return Number.isFinite(n) ? n : d;
};
const bool = (s: unknown): boolean => /^(true|1)$/i.test(String(s ?? '').trim());
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Evaluate a Chummer cost/capacity/slots formula: "Rating * 250", "25000 div 12", "[Rating]", "FixedValues(…)",
 * "[-(Capacity * 0.5 + 0.5*number((Capacity mod 2) = 1))]", "Body * 1000". Unknown names → null. Returns a number or null.
 */
export function chummerEval(expr: unknown, vars: Record<string, unknown> = {}): number | null {
  if (typeof expr === 'number') return expr;
  let s = String(expr ?? '').trim();
  if (!s) return null;
  if (/^[+-]?\d+(\.\d+)?$/.test(s.replace(',', '.'))) return Number(s.replace(',', '.'));
  const rating = Number(vars.Rating ?? vars.rating ?? 1) || 0;
  s = s.replace(/FixedValues\(([^)]*(?:\([^)]*\)[^)]*)*)\)/gi, (m, list: string) => {
    const vals = list.split(',').map((x) => x.trim());
    return `(${vals[Math.max(0, Math.min(vals.length - 1, (rating || 1) - 1))] || '0'})`;
  });
  s = s.replace(/[[\]{}]/g, '').replace(/\bdiv\b/gi, '/').replace(/\bmod\b/gi, '%').replace(/\bnumber\(/gi, '(').replace(/([^<>=!])=(?!=)/g, '$1===');
  s = s.replace(/[A-Za-z][A-Za-z ]*[A-Za-z]|[A-Za-z]/g, (name: string) => {
    const k = name.trim();
    const v = vars[k] ?? vars[k.charAt(0).toUpperCase() + k.slice(1)];
    return v === undefined || v === null || !Number.isFinite(Number(v)) ? 'NaN' : `(${Number(v)})`;
  });
  if (!/^[\d.+\-*/%()\s<>=!?:NaN]+$/.test(s)) return null;
  try {
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict"; return (${s});`)();
    const n = typeof v === 'boolean' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null;
  } catch {
    return null;
  }
}

export function sha1(s: unknown): string {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

/** Very small RTF → text converter (Chummer stores rich-text notes as RTF in some versions). */
export function rtfToText(s: unknown): string {
  const str = String(s || '');
  if (!/^\s*\{\\rtf/.test(str)) return str;
  let out = str
    .replace(/\{\\\*[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '')
    .replace(/\{\\(fonttbl|colortbl|stylesheet|info)[^]*?\}\s*\}/g, '')
    .replace(/\\par[d]?\b ?/g, '\n')
    .replace(/\\line\b ?/g, '\n')
    .replace(/\\tab\b ?/g, '\t')
    .replace(/\\'([0-9a-fA-F]{2})/g, (m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\??/g, (m, c: string) => String.fromCharCode((Number(c) + 65536) % 65536))
    .replace(/\\[a-zA-Z]+-?\d* ?/g, '')
    .replace(/\\([{}\\])/g, '$1')
    .replace(/[{}]/g, '');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** Clean multi-line text read from the file (line endings, RTF, HTML-ish tags). */
function longText(s: unknown): string {
  let t = rtfToText(String(s || '').replace(/\r\n/g, '\n'));
  if (/^\s*<(html|p|div|span|br)/i.test(t)) t = t.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '');
  return t.trim();
}

function guidOf(node: Element): string | null {
  return node.val('guid').toLowerCase() || null;
}
function sourceOf(node: Element): string | null {
  const s = node.val('sourceid').toLowerCase();
  return s && !/^0{8}-/.test(s) ? s : null;
}
function displayName(kind: DataKind, node: Element): string {
  const fr = frenchName(kind, sourceOf(node));
  const base = fr || node.val('name');
  const extra = node.val('extra');
  return extra ? `${base} (${extra})` : base;
}
/** Rulebook reference of a node (<source>SR5</source><page>435</page>) → { source, page? } fields, or {}. */
function bookRef(node: Element): { source?: string; page?: number } {
  const src = String(node.val('source') || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,11}$/.test(src)) return {};
  const page = parseInt(node.val('page'), 10);
  return page > 0 ? { source: src.toUpperCase(), page } : { source: src.toUpperCase() };
}
function srcNote(node: Element): string {
  const src = node.val('source');
  const page = node.val('page');
  return src ? `${src}${page ? ` p.${page}` : ''}` : '';
}

/** Enabled improvements of the file, grouped by type. */
function improvementsOf(c: Element): Improvement[] {
  const out: Improvement[] = [];
  for (const im of c.get('improvements')?.all('improvement') || []) {
    const en = im.val('enabled');
    if (en && /^(0|false)$/i.test(en)) continue;
    out.push({ type: im.val('improvementttype') || im.val('improvementtype'), name: im.val('improvedname'), val: num(im.val('val')), aug: num(im.val('aug')), source: im.val('improvementsource') });
  }
  return out;
}

/**
 * Parse a .chum5 file. Returns { actor, warnings (English), warningsI18n ([{ t, params }]), info: { created, appVersion, buildMethod, mugshot } }.
 * Throws ChummerError (English message + i18nKey/i18nParams) when the file is not a Chummer character.
 */
export function parseChum5(xml: unknown, { fileName = '', now = Date.now(), makeId = uid, keepXml = true, lang = SOURCE_LANG }: ParseOptions = {}): ParseResult {
  const tr = (key: string, params?: I18nParams): string => translate(lang, key, params);
  const trn = (n: number, one: string, other: string): string => translateN(lang, n, one, other);
  let doc: XmlDocument;
  try {
    doc = parseXml(xml);
  } catch (err) {
    if (err instanceof XmlError) throw i18nError({ t: 'Unreadable .chum5 file — {error}', params: { error: errorParam(err) } }, ChummerError);
    throw err;
  }
  const c = doc.root;
  if (c.name !== 'character') throw i18nError({ t: 'This file is not a Chummer5 character (.chum5)' }, ChummerError);
  const warn = warningList();
  const warnings = warn.list;
  const v = (n: string): string => c.val(n).trim();
  const imps = improvementsOf(c);
  // Chummer locations (<gearlocations>/<armorlocations>/<weaponlocations>) → actor.containers; items' <location> → item.location.
  const locs = locationsOf(c);
  // Gear with contents (pushGear) → bag containers linked to their item.
  const bags: Container[] = [];

  const alias = v('alias');
  const realName = v('name');
  const a = blankActor('pc', (alias || realName || tr(tk('Imported runner'))).slice(0, 80)) as unknown as ParsedActor;
  if (alias && realName && realName !== alias) a.realName = realName.slice(0, 120);
  const metaEn = v('metatype') || 'Human';
  a.metatype = METATYPE_FROM_EN[metaEn] || metaEn;
  if (!METATYPE_FROM_EN[metaEn]) warn.add({ t: 'Metatype “{metatype}” unknown to the app (kept as is).', params: { metatype: metaEn } });
  const gender = v('gender') || v('sex');
  a.gender = gender === 'Male' ? tr(tk('gender::Male')) : gender === 'Female' ? tr(tk('gender::Female')) : gender;
  const age = v('age');
  if (/^\d{1,3}$/.test(age)) a.age = Number(age);
  a.player = v('playername');
  a.concept = longText(v('concept')).split('\n')[0].slice(0, 200);

  // Free text
  const look = [[tk('Eyes: {value}'), 'eyes'], [tk('Hair: {value}'), 'hair'], [tk('Height: {value}'), 'height'], [tk('Weight: {value}'), 'weight'], [tk('Skin: {value}'), 'skin']]
    .map(([key, k]) => (v(k) ? tr(key, { value: v(k) }) : ''))
    .filter(Boolean)
    .join(' · ');
  const bio = [];
  const desc = longText(c.val('description'));
  if (desc) bio.push(desc);
  if (look) bio.push(tr(tk('**Appearance** — {look}'), { look }));
  if (age && !/^\d{1,3}$/.test(age)) bio.push(tr(tk('**Age** — {age}'), { age }));
  const bg = longText(c.val('background'));
  if (bg) bio.push(`### ${tr(tk('chummer::Background'))}\n\n${bg}`);
  const concept = longText(c.val('concept'));
  if (concept.includes('\n')) bio.push(`### ${tr(tk('Concept'))}\n\n${concept}`);
  a.bio = bio.join('\n\n');
  const notes = [longText(c.val('notes')), longText(c.val('gamenotes')) ? `### ${tr(tk('Game notes'))}\n\n${longText(c.val('gamenotes'))}` : ''].filter(Boolean);
  a.notes = notes.join('\n\n');
  if (v('metavariant')) a.metavariant = v('metavariant');

  // Mode & money
  const created = bool(v('created'));
  let careerKarma = 0;
  let hasKarmaExpenses = false;
  for (const e of c.get('expenses')?.all('expense') || []) {
    if (e.val('type') !== 'Karma') continue;
    hasKarmaExpenses = true;
    const amt = num(e.val('amount'));
    if (amt > 0 || bool(e.val('refund'))) careerKarma += amt;
  }
  a.karma = Math.round(num(v('karma')));
  a.karmaTotal = Math.max(a.karma, c.has('totalkarma') ? Math.round(num(v('totalkarma'))) : hasKarmaExpenses ? Math.round(careerKarma) : a.karma);
  a.nuyen = Math.round(num(v('nuyen')));
  const streetBase = created ? Math.floor(Math.max(careerKarma, 0) / 10) : 0;
  const impSum = (type: string): number => imps.filter((i) => i.type === type).reduce((t, i) => t + i.val, 0);
  a.streetCred = Math.max(0, streetBase + impSum('StreetCred') + Math.round(num(v('streetcred'))) - Math.round(num(v('burntstreetcred'))));
  a.notoriety = Math.max(0, Math.round(num(v('notoriety')) + impSum('Notoriety') + num(v('burntstreetcred'))));
  a.publicAwareness = Math.max(0, Math.round(num(v('publicawareness')) + impSum('PublicAwareness')));
  if (!created) warn.add({ t: 'Character still in creation mode in Chummer: remaining karma and nuyen may differ from what Chummer shows.' });

  // Attributes: value = metatype min + base + karma; totalvalue (when present) includes augmentations.
  const magEnabled = bool(v('magenabled'));
  const resEnabled = bool(v('resenabled'));
  a.augmented = {};
  const seen = new Set<string>();
  for (const at of c.get('attributes')?.all('attribute') || []) {
    const k = at.val('name').toUpperCase() as AttrKey;
    if (!APP_ATTRS.includes(k) || seen.has(k)) continue;
    seen.add(k);
    if (k === 'MAG' && !magEnabled) continue;
    if (k === 'RES' && !resEnabled) continue;
    const natural = num(at.val('metatypemin')) + num(at.val('base')) + num(at.val('karma'));
    let value = natural;
    if (at.has('totalvalue')) {
      const total = num(at.val('totalvalue'), natural);
      if (k === 'MAG' || k === 'RES') value = Math.min(natural, total); // essence loss lowers the rating
      else if (total > natural) a.augmented![k] = total - natural;
    }
    a.attributes[k] = value;
  }
  if (!Object.keys(a.augmented).length) delete a.augmented;
  a.edge.current = Math.max(0, a.attributes.EDG - Math.round(num(v('edgeused'))));

  // Initiative dice / bonus from improvements (wired reflexes, improved reflexes, synaptic booster…)
  const extraDice = imps.filter((i) => /^InitiativeDice|^InitiativePass/i.test(i.type)).reduce((s, i) => s + (i.val || i.aug), 0);
  const initBonus = imps.filter((i) => i.type === 'Initiative').reduce((s, i) => s + (i.val || i.aug), 0);
  const baseDice = num(v('initiativedice'), 1) || 1;
  if (extraDice || initBonus || baseDice !== 1) a.initiative = { dice: Math.max(1, Math.min(5, baseDice + extraDice)), bonus: initBonus };

  // Skills
  const sd = skillsData();
  const groups: Record<string, { base: number; karma: number; broken?: boolean }> = {};
  for (const g of c.get('newskills/groups')?.all('group') || []) groups[norm(g.val('name'))] = { base: num(g.val('base')), karma: num(g.val('karma')), broken: bool(g.val('isbroken')) };
  const freeBase: Record<string, number> = {};
  for (const im of imps) if (im.type === 'SkillBase' && im.name) freeBase[norm(im.name)] = (freeBase[norm(im.name)] || 0) + im.val;
  const knoNodes = [...(c.get('newskills/knoskills')?.all('skill') || [])];
  for (const s of c.get('newskills/skills')?.all('skill') || []) {
    if (bool(s.val('isknowledge'))) {
      knoNodes.push(s);
      continue;
    }
    const def = sd.byId.get(s.val('suid').toLowerCase()) || sd.byName.get(norm(s.val('name')));
    const name = s.val('name') || def?.name;
    if (!name) continue;
    const g = groups[norm(def?.group || s.val('skillgroup'))] || { base: 0, karma: 0 };
    const rating = Math.max(num(s.val('base')), g.base) + (freeBase[norm(name)] || 0) + num(s.val('karma')) + g.karma;
    if (!rating) continue;
    const id = appSkillId(name);
    const app = SKILL_BY_ID[id];
    const specific = s.val('specific');
    const specs = (s.get('specs')?.all('spec') || []).map((sp) => sp.val('name')).filter(Boolean);
    a.skills.push({
      id: id === 'exotic_weapon' && a.skills.some((x) => x.id === id) ? `${id}_${a.skills.length}` : id,
      name: (app ? app.fr : name) + (specific ? ` (${specific})` : ''),
      attr: (app ? app.attr : String(def?.attr || s.val('attribute') || 'AGI').toUpperCase()) as AttrKey,
      rating,
      ...(specs.length ? { spec: specs.join(', ') } : {}),
      ...(app?.group ? { group: app.group } : {}),
    });
  }
  for (const s of knoNodes) {
    const name = s.val('name');
    if (!name) continue;
    const type = KNO_TYPES[norm(s.val('type') || s.val('skillcategory'))] || 'interest';
    const native = bool(s.val('isnativelanguage'));
    const specs = (s.get('specs')?.all('spec') || []).map((sp) => sp.val('name')).filter(Boolean);
    const kno: KnowledgeSkill = {
      id: makeId('kno'), name, rating: native ? 0 : num(s.val('base')) + num(s.val('karma')) + (freeBase[norm(name)] || 0), type,
      ...(native ? { native: true } : {}), ...(specs.length ? { spec: specs.join(', ') } : {}), ...(guidOf(s) ? { chummerGuid: guidOf(s)! } : {}),
    };
    a.knowledge.push(kno);
  }

  // Qualities
  for (const q of c.get('qualities')?.all('quality') || []) {
    if (!q.val('name')) continue;
    const positive = q.val('qualitytype') !== 'Negative';
    const karma = Math.abs(num(q.val('bp'))) * (positive ? 1 : -1);
    const src = q.val('qualitysource');
    const note = [srcNote(q), /^Metatype/.test(src) ? tr(tk('metatype trait')) : '', longText(q.val('notes'))].filter(Boolean).join(' — ');
    a.qualities.push(withRef({ id: makeId('itm'), name: displayName('qualities', q), karma, positive, ...(note ? { notes: note } : {}) }, q));
  }

  const ammoRefs: Array<[Weapon, string]> = []; // [weapon, guid of the gear loaded in its active clip]
  const slotRefs: Array<[Weapon, number, string]> = []; // [weapon, slot, guid of the gear loaded in that other clip]
  // Units of a gear item by guid (a hand grenade's weapon node points at its gear with <parentid>).
  let gearQtys: Map<string, number> | null = null;
  const gearQty = (guid: unknown): number => {
    if (!gearQtys) {
      gearQtys = new Map();
      const walk = (node: Element) => {
        for (const ch of node.elements) {
          if (ch.name === 'gear' && ch.val('guid')) gearQtys!.set(ch.val('guid').trim().toLowerCase(), num(ch.val('qty'), 1));
          walk(ch);
        }
      };
      walk(c);
    }
    return gearQtys.get(String(guid || '').trim().toLowerCase()) || 0;
  };
  // Weapons. Chummer's built-in Unarmed Attack becomes the app's « Unarmed » (« Mains nues » on a French table, isUnarmed()) (accuracy « Physical »: the physical limit with its
  // modifiers, recomputed when STR / BOD / REA change — shared/modifiers.js weaponAccuracy).
  let unarmedDone = false;
  for (const w of c.get('weapons')?.all('weapon') || []) {
    const name = w.val('name');
    if (!name) continue;
    if (name === 'Unarmed Attack') {
      if (unarmedDone) continue;
      unarmedDone = true;
      a.weapons.push(withRef<Weapon>({
        id: makeId('itm'), name: tr(tk('weapon::Unarmed')), category: tr(tk('Melee')), kind: 'melee', skill: 'unarmed_combat', accuracy: 'Physical',
        damage: w.val('damage').replace(/\{STR\}/g, 'STR') || '(STR)S', ap: 0, mode: '', rc: 0, ammo: '', reach: num(w.val('reach')), notes: 'Unarmed Attack (SR5 132)',
      }, w));
      continue;
    }
    const wi = weaponFromNode(w, makeId);
    placeItem(wi, w, locs);
    // Chummer's <equipped> is not « ready » (Chummer marks nearly every weapon equipped): the app's ready defaults apply
    // (sheet/inventory.js normalizeInventory) and the export never writes the ready state back.
    // Hand grenades (« <ammo>1</ammo> », throwing skill) are single-use items, not one-round guns: no magazine, a unit count.
    if (isThrownExplosive(wi)) {
      wi.ammo = '';
      wi.qty = Math.max(1, Math.round(gearQty(w.val('parentid')) || 1));
      a.weapons.push(wi);
      continue;
    }
    const clip = parseAmmo(wi.ammo).max > 0 ? activeClip(w) : null;
    if (clip) {
      wi.ammoLoaded = clip.count;
      if (clip.gearGuid) ammoRefs.push([wi, clip.gearGuid]);
      // Several ammo slots (Additional Clip/Magazine: Beretta Northstar…): every magazine, the active one mirrored in ammoLoaded
      // (sheet/inventory.ts normalizeMagazines checks the count against the accessories).
      const all = allClips(w);
      if (all.length > 1) {
        wi.ammoSlots = all.map((m) => ({ loaded: m.count, ammoKind: null }));
        wi.activeSlot = clip.slot;
        all.forEach((m, i) => {
          if (m.gearGuid && i !== clip.slot) slotRefs.push([wi, i, m.gearGuid]);
        });
      }
    }
    a.weapons.push(wi);
  }

  // Armor
  for (const ar of c.get('armors')?.all('armor') || []) {
    if (!ar.val('name')) continue;
    const raw = ar.val('armoroverride') || ar.val('armor');
    const rating = /^[+-]?\d+$/.test(raw.trim()) ? Math.abs(num(raw.replace('+', ''))) : Math.max(0, num(evalFormula(raw.replace(/^\+/, ''), num(ar.val('rating'), 1)), 0));
    const capacity = Math.max(0, chummerEval(ar.val('armorcapacity'), { Rating: num(ar.val('rating'), 1) }) ?? 0);
    const mods = (ar.get('armormods')?.all('armormod') || []).filter((m) => m.val('name')).map((m) => armorModFromNode(m, capacity, makeId));
    const note = [srcNote(ar), longText(ar.val('notes'))].filter(Boolean).join(' — ');
    a.armor.push(placeItem(withRef({
      id: makeId('itm'), name: displayName('armor', ar), rating, equipped: bool(ar.val('equipped')), ...(raw.trim().startsWith('+') ? { stack: true } : {}),
      ...(capacity ? { capacity } : {}), ...(mods.length ? { mods } : {}), ...(note ? { notes: note } : {}),
    }, ar), ar, locs));
    for (const g of ar.get('gears')?.all('gear') || []) pushGear(g, tr(tk('in {name}'), { name: ar.val('name') }));
  }

  // Cyberware / bioware (children flattened, flagged as included)
  const grades = { ...gradeTable('cyberware'), ...gradeTable('bioware') };
  let essLoss = 0;
  const pushWare = (cw: Element, parentName: string | null): void => {
    if (!cw.val('name')) return;
    const rating = num(cw.val('rating'));
    const kind = /bioware/i.test(cw.val('improvementsource')) ? 'bioware' : 'cyberware';
    const gradeName = cw.val('grade') || 'Standard';
    const mult = grades[gradeName]?.ess ?? (/alpha/i.test(gradeName) ? 0.8 : /beta/i.test(gradeName) ? 0.7 : /delta/i.test(gradeName) ? 0.5 : /used/i.test(gradeName) ? 1.25 : 1);
    const rawEss = cw.val('ess');
    const base = /^[\d.,\s]+$/.test(rawEss) ? num(rawEss) : evalFormula(rawEss.replace(/\[|\]/g, ''), rating || 1);
    // A child implant (cybereye enhancement, cyberlimb part…) costs no essence of its own unless Chummer adds it to the
    // parent's (<addtoparentess>): it uses the parent's capacity, as in Chummer's totals.
    const ess = parentName && !bool(cw.val('addtoparentess')) ? 0 : Math.round((base || 0) * mult * 10000) / 10000;
    essLoss += ess;
    const g = gradeName.toLowerCase();
    const side = cw.val('location');
    const note = [parentName ? tr(tk('Subsystem of {name}'), { name: parentName }) : '', side ? (side === 'Left' ? tr(tk('left side')) : side === 'Right' ? tr(tk('right side')) : tr(tk('side: {side}'), { side })) : '', srcNote(cw), longText(cw.val('notes'))].filter(Boolean).join(' — ');
    a.augmentations.push(withRef<Augmentation>({
      id: makeId('itm'), name: displayName(kind, cw), kind,
      grade: g.includes('alpha') ? 'alpha' : g.includes('beta') ? 'beta' : g.includes('delta') ? 'delta' : g.includes('used') ? 'used' : 'standard',
      ...(rating ? { rating } : {}), essence: ess, ...(note ? { notes: note } : {}),
    }, cw));
    for (const ch of cw.get('children')?.all('cyberware') || []) pushWare(ch, cw.val('name'));
    for (const gg of cw.get('gears')?.all('gear') || []) pushGear(gg, tr(tk('in {name}'), { name: cw.val('name') }));
    for (const ww of cw.get('weapons')?.all('weapon') || []) a.weapons.push(weaponFromNode(ww, makeId, tr(tk('built into {name}'), { name: cw.val('name') })));
  };
  for (const cw of c.get('cyberwares')?.all('cyberware') || []) pushWare(cw, null);
  const totEss = v('totaless');
  a.attributes.ESS = totEss ? round2(num(totEss, 6)) : Math.max(0, round2(6 - essLoss));

  // Gear (commlinks/decks feed the matrix block, SINs feed `sins`, programs feed matrix.programs).
  // Gear holding loose gear (a backpack and its contents) becomes a bag: the item stays (cost, notes) and a container
  // `chumgear_<guid>` linked to it (`itemId`) holds its children. Accessories (a scope on glasses, rope in a grapple gun)
  // stay flat items with an « in {parent} » note, at their parent's location.
  // `inherited` = location of the parent item (accessories) or the parent's bag container (contents).
  function pushGear(g: Element, where: string, inherited?: string): void {
    const name = g.val('name');
    if (!name) return;
    if (bool(g.val('includedinparent'))) return;
    const category = g.val('category');
    if (PROGRAM_CATS.test(category) && a.matrix) {
      a.matrix.programs.push(g.val('extra') ? `${name} (${g.val('extra')})` : name);
      return;
    }
    if (/^ID\/Credsticks$/i.test(category) && /\bSIN\b/i.test(name)) {
      const licenses = (g.get('children')?.all('gear') || []).filter((x) => /license/i.test(x.val('name'))).map((x) => x.val('extra') || x.val('name'));
      a.sins.push(withRef({ id: makeId('itm'), name: g.val('extra') || name, rating: num(g.val('rating')), licenses }, g));
      for (const ch of g.get('children')?.all('gear') || []) if (!/license/i.test(ch.val('name'))) pushGear(ch, tr(tk('with {name}'), { name: g.val('extra') || name }));
      return;
    }
    if (MATRIX_CATS.test(category) && !a.matrix) {
      const array = g.val('attributearray').split(',').map((x) => num(x));
      const dr = num(g.val('devicerating'));
      a.matrix = {
        device: name, rating: dr,
        attack: num(g.val('attack'), array[0] || 0), sleaze: num(g.val('sleaze'), array[1] || 0),
        dataProcessing: num(g.val('dataprocessing'), array[2] || dr), firewall: num(g.val('firewall'), array[3] || dr),
        programs: [],
      };
    }
    const rating = num(g.val('rating'));
    const loc = locs.resolve(g.val('location')) || inherited;
    const note = [where || '', g.val('location') && !locs.resolve(g.val('location')) ? tr(tk('location: {location}'), { location: g.val('location') }) : '', srcNote(g), longText(g.val('notes'))].filter(Boolean).join(' — ');
    const custom = g.val('gearname');
    // Ammunition: Chummer <ammoforweapontype> (file, else data) tells which weapons it feeds (client/modules/sheet/inventory.js).
    const ammoFor = /^Ammunition$/i.test(category) ? g.val('ammoforweapontype') || findDataItem('gear', { id: sourceOf(g) })?.val('ammoforweapontype') || '' : '';
    const item = withRef({
      id: makeId('itm'), name: custom || displayName('gear', g), category: frenchCategory('gear', sourceOf(g)) || category, ...(rating ? { rating } : {}), qty: num(g.val('qty'), 1) || 1, ...(note ? { notes: note } : {}),
      ...(loc ? { location: loc } : {}), ...(ammoFor ? { ammoFor: String(ammoFor).slice(0, 40) } : {}),
    }, g);
    a.gear.push(item);
    const kids = (g.get('children')?.all('gear') || []).filter((ch) => ch.val('name') && !bool(ch.val('includedinparent')));
    const guid = g.val('guid').trim().toLowerCase();
    if (guid && isBagGear(g, kids)) {
      const bag: Container = { id: `chumgear_${guid}`, name: item.name.slice(0, 60), kind: 'bag', itemId: item.id };
      bags.push(bag);
      for (const ch of kids) pushGear(ch, '', bag.id);
    } else {
      for (const ch of kids) pushGear(ch, tr(tk('in {name}'), { name: custom || name }), loc);
    }
  }
  for (const g of c.get('gears')?.all('gear') || []) pushGear(g, '');
  // Loaded ammunition of the weapons (the gear of their active clip).
  for (const [wi, guid] of ammoRefs) {
    const g = a.gear.find((x) => x.chummerGuid === guid);
    if (g) wi.ammoKind = ammoKindOf(g) as AmmoKind | null;
  }
  for (const [wi, i, guid] of slotRefs) {
    const g = a.gear.find((x) => x.chummerGuid === guid);
    if (g && wi.ammoSlots?.[i]) wi.ammoSlots[i].ammoKind = ammoKindOf(g) as AmmoKind | null;
  }
  if (locs.containers.length || bags.length) a.containers = [...locs.containers, ...bags];

  // Vehicles & drones
  for (const vh of c.get('vehicles')?.all('vehicle') || []) {
    if (!vh.val('name')) continue;
    const mods = (vh.get('mods')?.all('mod') || []).filter((m) => m.val('name')).map((m) => vehicleModFromNode(m, vh, makeId));
    const weapons: string[] = [];
    vh.walk((n) => {
      if (n.name === 'weapon' && n.val('name')) weapons.push(n.val('name'));
    });
    const note = [srcNote(vh), weapons.length ? tr(tk('Weapons: {list}'), { list: weapons.join(', ') }) : '', longText(vh.val('notes'))].filter(Boolean).join(' — ');
    a.vehicles.push(withRef({
      id: makeId('itm'), name: vh.val('vehiclename') || displayName('vehicles', vh), handling: vh.val('handling'), speed: vh.val('speed'), accel: vh.val('accel'),
      body: num(vh.val('body')), armor: num(vh.val('armor')), pilot: num(vh.val('pilot')), sensor: num(vh.val('sensor')), seats: num(vh.val('seats')),
      ...(mods.length ? { mods } : {}), ...(note ? { notes: note } : {}),
    }, vh));
  }

  // Contacts (enemies are kept, flagged in the notes)
  for (const ct of c.get('contacts')?.all('contact') || []) {
    if (!ct.val('name')) continue;
    const enemy = ct.val('type') === 'Enemy';
    const note = [enemy ? tr(ENEMY_NOTE) : '', ct.val('location') ? tr(tk('Place: {place}'), { place: ct.val('location') }) : '', longText(ct.val('notes'))].filter(Boolean).join(' — ');
    a.contacts.push(withRef({ id: makeId('itm'), name: ct.val('name'), role: ct.val('role'), connection: num(ct.val('connection'), 1), loyalty: num(ct.val('loyalty'), 1), ...(note ? { notes: note } : {}) }, ct));
  }

  // Adept powers
  for (const p of c.get('powers')?.all('power') || []) {
    if (!p.val('name')) continue;
    const level = num(p.val('rating'));
    const levels = p.has('levels') ? bool(p.val('levels')) : level > 1;
    const ppl = num(p.val('pointsperlevel'));
    const pp = round2(Math.max(0, (levels ? ppl * (level || 1) : ppl) + num(p.val('extrapointcost')) - (bool(p.val('discounted')) ? 0.25 : 0)));
    const note = srcNote(p);
    a.powers.push(withRef({ id: makeId('itm'), name: displayName('powers', p), ...(levels && level ? { level } : {}), pp, ...(note ? { notes: note } : {}) }, p));
  }

  // Spells & complex forms
  for (const s of c.get('spells')?.all('spell') || []) {
    if (!s.val('name')) continue;
    const flags = [bool(s.val('alchemical')) ? tr(tk('spell::alchemical')) : '', bool(s.val('extended')) ? tr(tk('spell::extended')) : '', bool(s.val('limited')) ? tr(tk('spell::limited')) : ''].filter(Boolean);
    const note = [srcNote(s), flags.join(', ')].filter(Boolean).join(' — ');
    a.spells.push(withRef({ id: makeId('itm'), name: displayName('spells', s), category: s.val('category'), type: s.val('type'), range: s.val('range'), duration: s.val('duration'), drain: s.val('dv'), ...(note ? { notes: note } : {}) }, s));
  }
  const forms = (c.get('complexforms')?.all('complexform') || []).filter((f) => f.val('name'));
  if (forms.length) a.complexForms = forms.map((f) => withRef({ id: makeId('itm'), name: f.val('name') + (f.val('extra') ? ` (${f.val('extra')})` : ''), target: f.val('target'), duration: f.val('duration'), fading: f.val('fv') }, f));

  // Lifestyles with their qualities (Garage, DocWagon contract, Extra Secure…). Primary: the primary tenant's, else the most expensive.
  for (const ls of (c.get('lifestyles')?.all('lifestyle') || []).filter((l) => l.val('name') || l.val('baselifestyle'))) {
    const base = ls.val('baselifestyle') || 'Medium';
    const costFor = (k: string): number => num(ls.val(`costfor${k}`) || (k === 'area' ? ls.val('costforearea') : ''));
    const extra = ['area', 'comforts', 'security'].reduce((sum, k) => sum + num(ls.val(k)) * costFor(k), 0);
    const advanced = ls.val('type') === 'Advanced';
    const points = advanced ? { comforts: num(ls.val('basecomforts')) + num(ls.val('comforts')), security: num(ls.val('basesecurity')) + num(ls.val('security')), neighborhood: num(ls.val('basearea')) + num(ls.val('area')) } : null;
    const roommates = num(ls.val('roommates'));
    const pct = num(ls.val('percentage'), 100);
    const notes = [longText(ls.val('notes')), roommates ? trn(roommates, tk('{n} roommate'), tk('{n} roommates')) : '', pct !== 100 ? tr(tk('share paid: {pct}%'), { pct }) : ''].filter(Boolean).join(' — ');
    // monthlyCost is set below (same key order as before).
    const item = {
      id: makeId('ls'), name: ls.val('name') || base, base, baseCost: Math.round(num(ls.val('cost'), (LIFESTYLE_BASES as Record<string, { cost: number } | undefined>)[base]?.cost || 0)), ...(extra > 0 ? { extraCost: Math.round(extra) } : {}), monthsPaid: num(ls.val('months')),
      primary: false, ...(points ? { points } : {}),
      qualities: (ls.get('lifestylequalities')?.all('lifestylequality') || []).filter((q) => q.val('name')).map((q) => lifestyleQualityFromNode(q, makeId)),
      notes, _tenant: bool(ls.val('primarytenant')),
    } as TenantLifestyle;
    if (sourceOf(ls)) item.catalogId = sourceOf(ls)!;
    if (guidOf(ls)) item.chummerGuid = guidOf(ls)!;
    Object.assign(item, bookRef(ls));
    item.monthlyCost = Math.round(Number(monthlyCost(item)) || 0);
    a.lifestyles.push(item);
  }
  if (a.lifestyles.length) {
    const main = (a.lifestyles as TenantLifestyle[]).find((l) => l._tenant) || [...a.lifestyles].sort((x, y) => y.monthlyCost - x.monthlyCost)[0];
    main.primary = true;
  }
  for (const l of a.lifestyles as TenantLifestyle[]) delete l._tenant;

  // Martial arts (Run & Gun) and their techniques
  for (const m of (c.get('martialarts')?.all('martialart') || []).filter((x) => x.val('name'))) {
    const techniques = (m.get('martialarttechniques')?.all('martialarttechnique') || m.get('techniques')?.all('technique') || []).filter((t) => t.val('name'))
      .map((t) => ({ ...subHead('techniques', t, makeId), ...(longText(t.val('notes')) ? { notes: longText(t.val('notes')) } : {}) }));
    const head = subHead('martialarts', m, makeId);
    const notes = longText(m.val('notes'));
    a.martialArts.push({
      id: makeId('itm'), name: head.nameFr || head.name, rating: Math.max(1, num(m.val('rating'), 1)), techniques, ...(notes ? { notes } : {}),
      ...(head.catalogId ? { catalogId: head.catalogId } : {}), ...(head.chummerGuid ? { chummerGuid: head.chummerGuid } : {}),
      ...(head.source ? { source: head.source, ...(head.page ? { page: head.page } : {}) } : {}),
    });
  }

  // Extras that the app has no dedicated place for: summarized in the notes.
  const extras: string[] = [];
  const grade = num(v('initiategrade'));
  const metamagics = (c.get('metamagics')?.all('metamagic') || []).map((m) => m.val('name')).filter(Boolean);
  const list = metamagics.join(', ');
  if (grade) extras.push(metamagics.length ? tr(tk('Initiate grade {grade} — metamagics: {list}'), { grade, list }) : tr(tk('Initiate grade {grade}'), { grade }));
  const sub = num(v('submersiongrade'));
  if (sub) extras.push(metamagics.length ? tr(tk('Submersion grade {grade} — echoes: {list}'), { grade: sub, list }) : tr(tk('Submersion grade {grade}'), { grade: sub }));
  const foci = (c.get('foci')?.all('focus') || []).map((f) => f.val('name')).filter(Boolean);
  if (foci.length) extras.push(tr(tk('Bonded foci: {list}'), { list: foci.join(', ') }));
  const spirits = (c.get('spirits')?.all('spirit') || []).map((s) => {
    const force = s.val('force') ? ` (${tr(tk('Force {force}'), { force: s.val('force') })})` : '';
    const services = s.val('services') ? `, ${trn(num(s.val('services')), tk('{n} service'), tk('{n} services'))}` : '';
    return `${s.val('name')}${force}${services}`;
  }).filter((x) => x.trim());
  if (spirits.length) extras.push(tr(tk('Spirits / sprites: {list}'), { list: spirits.join(' ; ') }));
  const mentor = (c.get('mentorspirits')?.all('mentorspirit') || []).map((m) => m.val('name')).filter(Boolean);
  if (mentor.length) extras.push(tr(tk('Mentor: {list}'), { list: mentor.join(', ') }));
  // Tradition of a magician (technomancer streams, traditiontype RES, are not stored): actor.magic.tradition (47-magic).
  const tradition = c.get('tradition');
  if (tradition?.val('name') && (tradition.val('traditiontype') || 'MAG') === 'MAG') {
    const t = chummerTradition({
      sourceid: tradition.val('sourceid'), name: tradition.val('name'), drain: tradition.val('drain'), source: tradition.val('source'), page: tradition.val('page'),
      spirits: { combat: tradition.val('spiritcombat'), detection: tradition.val('spiritdetection'), health: tradition.val('spirithealth'), illusion: tradition.val('spiritillusion'), manipulation: tradition.val('spiritmanipulation') },
    });
    if (t) a.magic = { ...(a.magic || {}), tradition: t };
  }
  if (extras.length) a.bio = [a.bio, `### ${tr(tk('Chummer data'))}\n\n${extras.map((x) => `- ${x}`).join('\n')}`].filter(Boolean).join('\n\n');

  // Condition monitor (Chummer stores overflow inside physicalcmfilled)
  const bodTotal = (a.attributes.BOD || 1) + (a.augmented?.BOD || 0);
  const wilTotal = (a.attributes.WIL || 1) + (a.augmented?.WIL || 0);
  const physCm = num(c.get('calculatedvalues')?.val('physicalcm'), 8 + Math.ceil(bodTotal / 2)) || 8 + Math.ceil(bodTotal / 2);
  const stunCm = num(c.get('calculatedvalues')?.val('stuncm'), 8 + Math.ceil(wilTotal / 2)) || 8 + Math.ceil(wilTotal / 2);
  const physFilled = Math.round(num(v('physicalcmfilled')));
  a.condition = { physical: Math.min(physFilled, physCm), stun: Math.min(Math.round(num(v('stuncmfilled'))), stunCm), overflow: Math.max(0, physFilled - physCm) };

  // Vision from metatype / qualities (map module)
  const qn = a.qualities.map((q) => norm(q.name)).join('|');
  if (/low-light|nyctalopie|vision nocturne/.test(qn) || ['Elfe', 'Ork'].includes(a.metatype)) a.vision = { ...(a.vision || {}), lowLight: true };
  if (/thermographic|thermographique/.test(qn) || ['Nain', 'Troll'].includes(a.metatype)) a.vision = { ...(a.vision || {}), thermo: true };

  const mugshots = c.get('mugshots')?.all('mugshot') || [];
  const mainIdx = Math.max(0, num(v('mainmugshotindex'), 0));
  const mugshot = (mugshots[mainIdx] || mugshots[0])?.text?.trim() || null;

  const imported = fileName ? { key: tk('Chummer5 import ({file})'), params: { file: fileName } } : { key: tk('Chummer5 import') };
  a.history = [{ ts: now, chummer: true, text: translate(SOURCE_LANG, imported.key, imported.params), i18n: imported, karma: a.karma, nuyen: a.nuyen }];
  const meta = metatypeData(metaEn);
  if (!meta && METATYPE_FROM_EN[metaEn]) warn.add({ t: 'Chummer metatype data not found.' });
  if (keepXml) {
    a.chummer = {
      xml: String(xml).replace(/^﻿/, ''), fileName: String(fileName || '').slice(0, 200), importedAt: now, syncedAt: now, sourceHash: sha1(xml),
      created, appVersion: v('appversion'), lang, bags: true,
    };
  }
  return { actor: a, warnings, warningsI18n: warn.i18n, info: { created, appVersion: v('appversion'), buildMethod: v('buildmethod'), mugshot } };
}

/** Nested item head: English name (+ extra), French name from the app catalog, catalog id, guid. */
function subHead(kind: DataKind, node: Element, makeId: MakeId): SubHead {
  const sid = sourceOf(node);
  const extra = node.val('extra');
  let fr = sid ? frenchName(kind, sid) : null;
  if (!fr && kind === 'techniques' && sid) fr = techniqueFr(sid);
  const out: SubHead = { id: makeId('sub'), name: node.val('name') + (extra ? ` (${extra})` : '') };
  if (fr) out.nameFr = fr + (extra ? ` (${extra})` : '');
  if (sid) out.catalogId = sid;
  const g = guidOf(node);
  if (g) out.chummerGuid = g;
  Object.assign(out, bookRef(node));
  return out;
}

/** French name of a martial art technique (techniques live inside the martialarts catalog entries). */
function techniqueFr(id: string): string | null {
  for (const e of appCatalog('martialarts').list) {
    for (const t of [...(Array.isArray(e.techniques) ? e.techniques : []), ...(Array.isArray(e.stats?.techniques) ? e.stats.techniques : [])]) {
      if (t && String(t.id || '').toLowerCase() === id && t.nameFr) return t.nameFr;
    }
  }
  return null;
}

const costOf = (node: Element, vars: Record<string, unknown>): number => {
  const raw = node.val('cost');
  const n = chummerEval(raw, vars);
  return n === null ? 0 : Math.round(n * 100) / 100;
};
const optNotes = (node: Element): string => longText(node.val('notes'));

/** <accessory> of a weapon → weapon.accessories[] item. */
function accessoryFromNode(x: Element, makeId: MakeId): Accessory {
  const rating = num(x.val('rating'));
  const mount = x.val('mount');
  const effects: NonNullable<Accessory['effects']> = {};
  const name = x.val('name');
  if (/smartgun/i.test(name)) effects.smartgun = true;
  else if (num(x.val('accuracy'))) effects.accuracy = num(x.val('accuracy'));
  if (num(x.val('rc'))) effects.rc = num(x.val('rc'));
  if (num(x.val('rcgroup'))) effects.rcGroup = num(x.val('rcgroup'));
  const notes = optNotes(x);
  return {
    ...subHead('accessories', x, makeId), mount: (['Top', 'Under', 'Barrel', 'Stock', 'Side', 'Internal'].includes(mount) ? mount : '') as MountPoint, ...(rating ? { rating } : {}),
    cost: costOf(x, { Rating: rating }), avail: x.val('avail'), effects, ...(bool(x.val('included')) ? { included: true } : {}), ...(x.has('equipped') && !bool(x.val('equipped')) ? { equipped: false } : {}),
    ...(notes ? { notes } : {}),
  };
}

/** <armormod> → armor.mods[] item (capacity evaluated with the armor's own capacity). */
function armorModFromNode(m: Element, armorCapacity: number, makeId: MakeId): ArmorMod {
  const rating = num(m.val('rating'));
  const cap = chummerEval(m.val('armorcapacity'), { Rating: rating, Capacity: armorCapacity });
  const armor = num(String(m.val('armor')).replace('+', ''));
  const notes = optNotes(m);
  return {
    ...subHead('armormods', m, makeId), ...(rating ? { rating } : {}), capacity: cap ?? 0, cost: costOf(m, { Rating: rating }), avail: m.val('avail'),
    ...(armor ? { effects: { armor } } : {}), ...(bool(m.val('included')) ? { included: true } : {}), ...(m.has('equipped') && !bool(m.val('equipped')) ? { equipped: false } : {}),
    ...(notes ? { notes } : {}),
  };
}

/** <mod> of a vehicle → vehicle.mods[] item. */
function vehicleModFromNode(m: Element, vh: Element, makeId: MakeId): VehicleMod {
  const rating = num(m.val('rating'));
  const vars = { Rating: rating, Body: num(vh.val('body')), Acceleration: num(String(vh.val('accel')).split('/')[0]), Handling: num(String(vh.val('handling')).split('/')[0]), Speed: num(String(vh.val('speed')).split('/')[0]), Pilot: num(vh.val('pilot')), Sensor: num(vh.val('sensor')), Armor: num(vh.val('armor')) };
  const notes = optNotes(m);
  return {
    ...subHead('vehiclemods', m, makeId), ...(rating ? { rating } : {}), slots: chummerEval(m.val('slots'), vars) ?? 0, category: m.val('category'), cost: costOf(m, vars), avail: m.val('avail'),
    ...(bool(m.val('included')) ? { included: true } : {}), ...(notes ? { notes } : {}),
  };
}

/** <lifestylequality> → lifestyle.qualities[] item. Standard lifestyles use <basemultiplier>, advanced (RF) ones <multiplier>. */
function lifestyleQualityFromNode(q: Element, makeId: MakeId): LifestyleQuality {
  const notes = optNotes(q);
  // <basemultiplier> (Extra Secure): % of the base cost only (shared/lifestyle.js baseOnly); <multiplier>: % of the whole.
  const mult = num(q.val('multiplier'));
  const baseMult = num(q.val('basemultiplier'));
  return {
    ...subHead('lifestylequalities', q, makeId), category: q.val('category'), cost: costOf(q, {}), multiplier: mult || baseMult, ...(!mult && baseMult ? { baseOnly: true } : {}),
    lp: num(q.val('lp')), ...(notes ? { notes } : {}),
  };
}

/**
 * Chummer locations → { containers: [{ id: 'chum_<guid>', name, kind }], resolve(<location> value) → container id | undefined }.
 * Recent files store the location's guid in the item's <location>, older ones its name. Same name in several lists = one container.
 */
function locationsOf(c: Element): Locations {
  const containers: Container[] = [];
  const byGuid = new Map<string, Container>();
  const byName = new Map<string, Container>();
  const add = (name: unknown, guid: string | null): Container | null => {
    const n = String(name || '').trim().slice(0, 60);
    if (!n) return null;
    let ct = byName.get(n.toLowerCase());
    if (!ct) {
      ct = { id: guid ? `chum_${guid}` : `chum_${n.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || containers.length}`, name: n, kind: guessContainerKind(n) as ContainerKind };
      containers.push(ct);
      byName.set(n.toLowerCase(), ct);
    }
    if (guid) byGuid.set(guid, ct);
    return ct;
  };
  for (const list of ['gearlocations', 'armorlocations', 'weaponlocations']) {
    for (const l of c.get(list)?.all('location') || []) add(l.val('name'), l.val('guid').trim().toLowerCase() || null);
  }
  const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const resolve = (v: unknown): string | undefined => {
    const s = String(v || '').trim();
    if (!s || /^0{8}-/.test(s)) return undefined;
    if (GUID.test(s)) return byGuid.get(s.toLowerCase())?.id;
    return (byName.get(s.toLowerCase()) || add(s, null))?.id;
  };
  return { containers, resolve };
}

/**
 * Gear node with children (`kids`: not included in it) that holds them like a bag: its name says so (backpack, case, sac…),
 * or none of the children is an accessory of it (a capacity slot « [n] », a category the parent takes as add-on, the
 * parent's own category other than Custom: rope of a grapple gun, refills of a medkit). Matrix devices never are.
 */
function isBagGear(g: Element, kids: Element[]): boolean {
  if (!kids.length || MATRIX_CATS.test(g.val('category'))) return false;
  if ([g.val('gearname'), g.val('name')].some((n) => guessContainerKind(n) === 'bag')) return true;
  const own = g.val('category').trim().toLowerCase();
  const addons = new Set([...g.all('addoncategory'), ...(findDataItem('gear', { id: sourceOf(g) })?.all('addoncategory') || [])].map((x) => x.text.trim().toLowerCase()));
  return kids.every((k) => {
    const cat = k.val('category').trim().toLowerCase();
    return !k.val('capacity').includes('[') && (cat !== own || cat === 'custom') && !addons.has(cat);
  });
}

/** item.location from the node's <location> (Chummer location guid or name); returns the item. */
function placeItem<T extends object>(item: T, node: Element, locs: Locations): T {
  const loc = locs.resolve(node.val('location'));
  if (loc) (item as { location?: string }).location = loc;
  return item;
}

/** Active clip of a weapon node (<clips><clip>, <activeammoslot> 1-based): { count, gearGuid } or null when the file has none. */
function activeClip(w: Element): { count: number; gearGuid: string | null; slot: number } | null {
  const clips = w.get('clips')?.all('clip') || [];
  if (!clips.length) return null;
  const i = Math.max(0, num(w.val('activeammoslot'), 1) - 1);
  const slot = clips[i] ? i : 0;
  const c = clipOf(clips[slot]);
  return c ? { ...c, slot } : null;
}

/** Every clip of a Chummer weapon (one per ammo slot), in slot order; [] when one is unreadable. */
function allClips(w: Element): Array<{ count: number; gearGuid: string | null }> {
  const out = (w.get('clips')?.all('clip') || []).map(clipOf);
  return out.every(Boolean) ? (out as Array<{ count: number; gearGuid: string | null }>) : [];
}

/** Rounds and loaded gear of one <clip>, or null. */
function clipOf(clip: Element): { count: number; gearGuid: string | null } | null {
  const raw = clip.has('count') ? clip.val('count') : clip.val('ammo');
  if (!/^\s*\d+\s*$/.test(raw)) return null;
  const id = (clip.val('id') || clip.val('guid')).trim().toLowerCase();
  return { count: Math.max(0, Math.round(num(raw))), gearGuid: id && !/^0{8}-/.test(id) ? id : null };
}

function withRef<T extends ItemBase>(item: T, node: Element): T {
  const g = guidOf(node);
  const s = sourceOf(node);
  if (s) item.catalogId = s;
  if (g) item.chummerGuid = g;
  if (!item.source) Object.assign(item, bookRef(node)); // 📖 chip (ARCHITECTURE.md « Rulebooks »)
  // Chummer <extra> = the choice of a « select… » bonus (Codeslinger's Matrix action, Aptitude's skill…): shared/modifiers.js item.choice.
  const extra = node.val('extra');
  if (extra && !item.choice) item.choice = String(extra).slice(0, 120);
  return item;
}

function weaponFromNode(w: Element, makeId: MakeId, where?: string): Weapon {
  const category = w.val('category');
  const skill = categoryToSkill(category, w.val('useskill'));
  const melee = w.val('type') === 'Melee' || MELEE_SKILLS.includes(skill);
  const accessories = (w.get('accessories')?.all('accessory') || []).filter((x) => x.val('name')).map((x) => accessoryFromNode(x, makeId));
  const mode = w.val('mode');
  const ammo = w.val('ammo');
  const note = [where || '', srcNote(w), longText(w.val('notes'))].filter(Boolean).join(' — ');
  const apRaw = w.val('ap');
  const data = sourceOf(w) ? findDataItem('weapons', { id: sourceOf(w) }) : null;
  const mounts = (data?.get('accessorymounts')?.all('mount') || []).map((m) => m.text.trim()).filter(Boolean);
  return withRef<Weapon>({
    id: makeId('itm'), name: w.val('weaponname') || displayName('weapons', w), category: frenchCategory('weapons', sourceOf(w)) || category, kind: melee ? 'melee' : 'ranged', skill,
    accuracy: w.val('accuracy'), damage: w.val('damage').replace(/\{STR\}/g, 'STR'),
    ap: /^[+-]?\d+$/.test(apRaw) ? Number(apRaw) : apRaw === '-' ? 0 : apRaw, mode: mode === '0' ? '' : mode, rc: num(w.val('rc')), ammo: ammo === '0' ? '' : ammo, reach: num(w.val('reach')),
    ...(accessories.length ? { accessories } : {}), ...(mounts.length ? { mounts: mounts as MountPoint[] } : {}), ...(note ? { notes: note } : {}),
  }, w);
}
