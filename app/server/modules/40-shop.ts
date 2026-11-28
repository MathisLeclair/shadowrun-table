// Shop module: gear catalog price authority, player purchases/sales, GM approval queue, fixer specials, lifestyles
// (several per actor, with upgrades), upgrades installed on owned items (weapon accessories, armor/vehicle mods),
// martial arts (karma, GM-approved).
// State slice: state.shop (see ARCHITECTURE.md > Shop & « Upgrades »). Pricing rules are shared with the client
// (client/modules/shop/rules.js), lifestyle costs with shared/lifestyle.js.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nuyen, deepClone } from '../../shared/util.ts';
import {
  SHOP_FILES, FILE_LABELS, GRADES, DEVICE_GEAR, UPGRADE_FILES, quote, targetList, parseAvailString, itemName,
  evalFormula, magicLoss, allowedGrades, fold, accessoryFit, accessoryEffects, armorCapacity, armorModFit, vehicleVars,
  vehicleModFit, vehicleModEffects, vehicleModMaxRating, martialKarma, lowersRent, upgradeAvail,
  AVAIL_TEST_MODES, availTestable, needsAvailTest, availBaseHours, availOutcome, durationText, matchAvailTests, clampOverpay, overpaySurcharge,
} from '../../client/modules/shop/rules.ts';
import { rollDice } from '../../shared/sr5.ts';
import { contactSheet } from '../../shared/contacts.ts';
import { performRoll } from './10-characters.ts';
import { HOME_LAYOUTS, homeLayout, homeMoveCost } from '../../shared/home.ts';
import { placeAt, samePlace } from '../../shared/city.ts';
import { activeCity } from '../lib/city.ts';
import { monthlyCost, settleLifestyles, primaryLifestyle, lifestyleFromCatalog, qualityFromCatalog, qualityProblem, baseOf } from '../../shared/lifestyle.ts';
import { removeBonus, weaponFromStats, bakeItemBonus } from '../lib/augment.ts';
import { formatSource } from '../lib/i18n.ts';
import { fillActorRefs } from '../lib/bookrefs.ts';
import { thrownGearToWeapons } from './10-characters.ts';
import type {
  ActionContext, Actor, ActorId, AvailRollInfo, AvailTest, ContactSheet, Legality, RollRecord, BiName, CatalogFile, CatalogItem, Contact, HistoryEntry, I18nEntry, I18nMessage, I18nParams, I18nParamValue, OrderLine, ServerEvents, ServerModule,
  ShopOrder, ShopSpecial, ShopState, TableState, UserId,
} from '../../shared/types.ts';

/** Catalog entries, owned items and their sub-items are read generically here (fields differ per catalog file / actor list). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
/** An actor read generically: its lists are indexed by name (`actor[list]`) and its items built field by field. */
type ShopActor = Loose & Pick<Actor, 'id' | 'name'>;
/** A catalog entry (data/catalog/*.json), stats read field by field. */
type Cat = CatalogItem<Loose>;
/** Catalog index entry: item + its catalog file. */
interface IndexEntry {
  item: Cat;
  file: CatalogFile;
}
/** One element of a list param (order lines, notes). */
type ParamItem = string | number | boolean | null | BiName | I18nMessage;
/** A note returned to the buyer: French key + params. */
type Note = I18nEntry;
/** A raw cart line (client payload: every field is validated by resolveLine). */
interface CartLine {
  ref?: string;
  qty?: number;
  rating?: number | null;
  grade?: string;
  price?: number;
  setMatrix?: boolean;
  /** Upgrades: weapon / armor / vehicle / lifestyle id. */
  target?: { itemId?: string };
  targetId?: string;
  /** Accessories. */
  mount?: string;
  /** New lifestyle (qty = months paid). */
  lifestyleName?: string;
  label?: string;
  primary?: boolean;
}
/** A rules message: French key string, or { key, params }. */
type RuleMessage = string | { key: string; params?: I18nParams };
/** Simulated upgrade targets of one order (deep clones). */
type Sim = Map<string, Loose>;

/** Marks a translatable key for tools/i18n-check.ts (English in client/i18n/en/shop.json). */
const tk = (s: string): string => s;

const CATALOG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'catalog');
const LISTS: string[] = ['weapons', 'armor', 'augmentations', 'gear', 'vehicles'];
const MAX_ORDERS = 400;
const APPROVAL_MODES: string[] = ['never', 'restricted', 'always'];
/** Nested list of each upgradable actor list. */
const SUB_OF: Record<string, string> = { weapons: 'accessories', armor: 'mods', vehicles: 'mods', lifestyles: 'qualities' };
/** Is this catalog file sold as an upgrade (installed on an owned item)? */
const isUpgradeFile = (f: string): boolean => !!UPGRADE_FILES[f as keyof typeof UPGRADE_FILES];

// ---------------------------------------------------------------------------
// Catalog index (server-side price authority)
// ---------------------------------------------------------------------------
const INDEX = new Map<string, IndexEntry>(); // catalog id -> { item, file }
const BY_NAME = new Map<string, IndexEntry>(); // folded English/French name -> { item, file } (to price legacy items without catalogId)
const MARTIAL = new Map<string, Cat>(); // martial art style id -> style (karma, data/catalog/martialarts.json)

function loadCatalogs() {
  INDEX.clear();
  BY_NAME.clear();
  MARTIAL.clear();
  for (const file of SHOP_FILES) {
    const p = path.join(CATALOG_DIR, `${file}.json`);
    let list: Cat[] = [];
    try {
      list = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      console.warn(`[shop] catalog ${file}.json missing or invalid (run npm run build:catalog)`);
      continue;
    }
    for (const item of list) {
      const entry: IndexEntry = { item, file: file as CatalogFile };
      INDEX.set(item.id, entry);
      if (isUpgradeFile(file) || file === 'lifestyles') continue; // legacy name lookup: owned items only
      for (const n of [item.name, item.nameFr]) {
        const k = fold(n);
        if (k && !BY_NAME.has(k)) BY_NAME.set(k, entry);
      }
    }
  }
  try {
    for (const m of JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, 'martialarts.json'), 'utf8'))) MARTIAL.set(m.id, m);
  } catch {
    console.warn('[shop] catalog martialarts.json missing or invalid (run npm run build:catalog)');
  }
}
loadCatalogs();

/** Catalog item by id (or undefined). */
const catalogItem = (id: string): Cat | undefined => INDEX.get(id)?.item;

/** Catalog entry of an owned item (by catalogId, else by name), or null. */
const catalogOf = (it: Loose | null | undefined): IndexEntry | null => (it?.catalogId && INDEX.get(it.catalogId)) || (it?.name ? BY_NAME.get(fold(it.name)) : null) || null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function defaults(): ShopState {
  return {
    open: true,
    markup: 0,
    sellRate: 50,
    maxAvail: 12,
    allowRestricted: true,
    allowForbidden: false,
    approval: 'restricted',
    availTest: 'required',
    availFree: 0,
    categories: Object.fromEntries(SHOP_FILES.map((f) => [f, true])),
    specials: [],
    orders: [],
    availTests: [],
  };
}

const int = (v: unknown, d = 0): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : d;
};
const clampInt = (v: unknown, lo: number, hi: number, d: number): number => Math.max(lo, Math.min(hi, int(v, d)));
const str = (v: unknown, max = 200): string => String(v ?? '').trim().slice(0, max);
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** ctx.fail with a rules message: French key string, or { key, params }. */
function failWith(ctx: ActionContext, m: RuleMessage): never {
  if (typeof m === 'string') ctx.fail(m);
  return ctx.fail(m.key, m.params);
}

function ownersOf(state: TableState, actorId: ActorId): UserId[] {
  return Object.values(state.users || {})
    .filter((u) => (u.characterIds || []).includes(actorId))
    .map((u) => u.id);
}

function getActor(ctx: ActionContext, actorId: unknown): ShopActor {
  const actor = ctx.state.actors?.[actorId as ActorId];
  if (!actor) return ctx.fail('Character not found');
  if (!ctx.owns(actorId as ActorId)) ctx.fail("That is not your character");
  return actor;
}

function notifyOwners<E extends keyof ServerEvents>(ctx: ActionContext, actorId: ActorId, event: E, data: ServerEvents[E]): void {
  const targets = [...new Set([...ownersOf(ctx.state, actorId), 'gm'])];
  ctx.emitTo(targets, event, data);
}

/** Shop log entry (visible to the actor's owners and the GM): key = English text with {placeholders}, translated by the client. */
function shopLog(ctx: ActionContext, actorId: ActorId, key: string, params: I18nParams): void {
  ctx.log({ kind: 'shop', userId: ctx.user.id, author: 'Shop', authorI18n: { key: 'Shop' }, i18n: { key, params }, to: [...new Set([...ownersOf(ctx.state, actorId), 'gm'])] });
}

/** Actor history entry: { text (French), i18n: { key, params } } + nuyen / karma delta. */
function history(actor: ShopActor, key: string, params: I18nParams, delta: number, karma?: number): void {
  actor.history = Array.isArray(actor.history) ? actor.history : [];
  const h: HistoryEntry = { ts: Date.now(), text: formatSource(key, params), i18n: { key, params } };
  if (delta) h.nuyen = delta;
  if (karma) h.karma = karma;
  actor.history.push(h);
  if (actor.history.length > 500) actor.history.splice(0, actor.history.length - 500);
}

function pushOrder(shop: ShopState, order: ShopOrder): void {
  shop.orders.push(order);
  if (shop.orders.length > MAX_ORDERS) {
    // Drop the oldest resolved orders first; never drop pending ones.
    let excess = shop.orders.length - MAX_ORDERS;
    shop.orders = shop.orders.filter((o) => {
      if (excess > 0 && o.status !== 'pending') {
        excess--;
        return false;
      }
      return true;
    });
  }
}

/** One order line as a translatable value: « Name (ind. 3) [Alphaware] ×2 → Target ». */
function lineText(l: Omit<Partial<OrderLine>, 'target'> & { target?: { name?: string } }): string | I18nMessage {
  let v: string | I18nMessage = l.name as string;
  if (l.rating) v = { t: tk('{name} (rtg {rating})'), params: { name: v, rating: l.rating } };
  if (l.grade && l.grade !== 'standard') v = { t: '{name} [{grade}]', params: { name: v, grade: GRADES[l.grade] ? { t: GRADES[l.grade].label } : l.grade } };
  if ((l.qty ?? 0) > 1) v = { t: '{name} ×{n}', params: { name: v, n: l.qty! } };
  if (l.target?.name) v = { t: tk('{name} → {target}'), params: { name: v, target: l.target.name } };
  return v;
}
/** Order lines as a translatable list param (rendered « a, b, c »). */
const summary = (items: OrderLine[]): ParamItem[] => items.map(lineText);
/** Notes ({ key, params }) as a translatable list param. */
const notesParam = (notes: Note[]): ParamItem[] => notes.map((n) => ({ t: n.key, ...(n.params ? { params: n.params } : {}) }));

// ---------------------------------------------------------------------------
// Upgrade targets (weapon / armor / vehicle / lifestyle owned by the actor)
// ---------------------------------------------------------------------------
/** Full catalog value of an owned item (for « Weapon Cost » / « Armor Cost » / « Vehicle Cost » formulas), or null. */
function baseValue(it: Loose | null | undefined): number | null {
  if (Number.isFinite(Number(it?.paid)) && it!.paid !== null && it!.paid !== '') return Number(it!.paid);
  const e = catalogOf(it);
  if (!e) return null;
  try {
    return quote(e.item, { rating: it!.rating }).unitCost;
  } catch {
    return null;
  }
}

/**
 * Target of an upgrade line. `sim` = Map of simulated targets (deep clones) so several lines of one order are checked together.
 * → { list, sub, target (clone), real (actor's item), cat (catalog item of the target or null) }
 */
function upgradeTarget(ctx: ActionContext, actor: ShopActor, file: string, raw: CartLine, sim: Sim) {
  const { list, sub } = UPGRADE_FILES[file as keyof typeof UPGRADE_FILES] as { list: string; sub: string };
  const id = str(raw?.target?.itemId ?? raw?.targetId, 80);
  if (!id) ctx.fail('Choose what to install this item on');
  const real: Loose | undefined = (Array.isArray(actor[list]) ? actor[list] : []).find((x: Loose) => x && x.id === id);
  if (!real) return ctx.fail('Target item not found');
  const key = `${list}:${id}`;
  if (!sim.has(key)) sim.set(key, deepClone(real));
  const target = sim.get(key)!;
  if (!Array.isArray(target[sub])) target[sub] = [];
  return { list, sub, target, real, cat: list === 'lifestyles' ? null : catalogOf(real)?.item || null };
}

/** Price + fit of an upgrade line on its (simulated) target; pushes the planned sub-item on the simulated target. */
function priceUpgrade(ctx: ActionContext, actor: ShopActor, file: string, item: Cat, raw: CartLine, sim: Sim): Loose {
  const shop = ctx.state.shop;
  const t = upgradeTarget(ctx, actor, file, raw, sim);
  const out = { target: { list: t.list, itemId: t.real.id, name: t.real.name } };
  if (file === 'lifestylequalities') {
    const problem = qualityProblem(t.target, item, catalogItem);
    if (problem) failWith(ctx, problem);
    const q = quote(item, { markup: 0 });
    const before = monthlyCost(t.target);
    t.target.qualities.push(qualityFromCatalog(item, { cost: q.base }));
    const delta = monthlyCost(t.target) - before;
    // Upgrades are monthly; already-paid months are topped up with the difference (nothing back when it lowers the rent).
    const months = Math.max(0, int(t.real.monthsPaid));
    return { ...out, q, unitCost: Math.max(0, delta) * months, monthlyDelta: delta, monthlyCost: q.base, ...(lowersRent(item) ? { lowersRent: true } : {}) };
  }
  // « +2R » items (availRelative): availability added to the target's (SR5 p.433 Smartgun System, Internal).
  const targetQ = t.cat ? (() => {
    try {
      return quote(t.cat, { rating: t.real.rating });
    } catch {
      return null;
    }
  })() : null;
  const priced = (o: Loose) => upgradeAvail(quote(item, o), item, targetQ);
  if (file === 'accessories') {
    const value = baseValue(t.real);
    if (item.stats?.targetCost && value === null) ctx.fail('Unknown price for {weapon}: cannot price {item}', { weapon: t.real.name, item: itemName(item) });
    const q = priced({ rating: raw.rating, markup: shop.markup, vars: { WeaponCost: value ?? 0 } });
    const fit = accessoryFit(t.target, t.cat, item, { mount: raw.mount === undefined ? undefined : str(raw.mount, 20) });
    if (fit.problem) failWith(ctx, fit.problem);
    t.target.accessories.push({ catalogId: item.id, mount: fit.mount });
    return { ...out, q, unitCost: q.unitCost, mount: fit.mount };
  }
  if (file === 'armormods') {
    const value = baseValue(t.real);
    if (item.stats?.targetCost && value === null && /ArmorCost/.test(item.costFormula || '')) ctx.fail('Unknown price for {weapon}: cannot price {item}', { weapon: t.real.name, item: itemName(item) });
    const cap = armorCapacity(t.target, t.cat);
    const q = priced({ rating: raw.rating, markup: shop.markup, vars: { ArmorCost: value ?? 0, Capacity: cap } });
    const fit = armorModFit(t.target, t.cat, item, q.rating);
    if (fit.problem) failWith(ctx, fit.problem);
    t.target.mods.push({ catalogId: item.id, capacity: fit.need });
    return { ...out, q, unitCost: q.unitCost, capacity: fit.need };
  }
  // vehiclemods
  const value = baseValue(t.real);
  const vars = vehicleVars(t.target, t.cat, value ?? 0);
  if (/VehicleCost/.test(item.costFormula || '') && value === null) ctx.fail('Unknown price for {weapon}: cannot price {item}', { weapon: t.real.name, item: itemName(item) });
  const max = vehicleModMaxRating(item, vars);
  const wanted = raw.rating === undefined || raw.rating === null ? item.rating?.min : Math.min(int(raw.rating, 1), max ?? int(raw.rating, 1));
  const q = priced({ rating: wanted, markup: shop.markup, vars });
  const fit = vehicleModFit(t.target, t.cat, item, q.rating, vars);
  if (fit.problem) failWith(ctx, fit.problem);
  t.target.mods.push({ catalogId: item.id, slots: fit.need, category: item.category || '' });
  return { ...out, q, unitCost: q.unitCost, slots: fit.need, effects: vehicleModEffects(item, q.rating, vars) };
}

// ---------------------------------------------------------------------------
// Purchase lines
// ---------------------------------------------------------------------------
/** Normalize one cart line into a priced, validated line. sim = simulated upgrade targets of the order. */
function resolveLine(ctx: ActionContext, raw: CartLine, actor: ShopActor, sim: Sim = new Map()): OrderLine {
  const shop = ctx.state.shop;
  const actorId = actor.id;
  const ref = str(raw?.ref, 120);
  if (!ref) ctx.fail('Missing item');
  const qty = int(raw?.qty, 1);
  if (qty < 1) ctx.fail('Invalid quantity');
  if (qty > 999) ctx.fail('Quantity too high');

  if (ref.startsWith('special:')) {
    const sp = shop.specials.find((s) => s.id === ref.slice(8));
    if (!sp || (!ctx.isGM && sp.hidden)) return ctx.fail('This deal no longer exists');
    if (!ctx.isGM && sp.forActorIds?.length && !sp.forActorIds.includes(actorId)) ctx.fail('This deal is reserved for another runner');
    const cat = sp.catalogRef ? INDEX.get(sp.catalogRef) : null;
    const file: CatalogFile = SHOP_FILES.includes(sp.file) && !isUpgradeFile(sp.file) ? sp.file : cat?.file && !isUpgradeFile(cat.file) ? cat.file : 'gear';
    const av = parseAvailString(sp.avail);
    const ware = file === 'cyberware' || file === 'bioware';
    let essence: number | undefined;
    if (ware) {
      if (Number.isFinite(Number(sp.essence)) && sp.essence !== null && (sp.essence as unknown) !== '') essence = round3(Number(sp.essence));
      else if (cat) essence = quote(cat.item, { rating: sp.rating, grade: sp.grade }).essence ?? 0;
      else essence = 0;
    }
    return {
      ref, specialId: sp.id, catalogId: cat?.item.id, file, name: sp.name, category: sp.category || cat?.item.categoryFr || cat?.item.category || '',
      qty, rating: sp.rating ?? null, grade: ware ? sp.grade || 'standard' : null, unitCost: Math.max(0, int(sp.cost)), availValue: av.value,
      legality: av.legality as Legality, essence, stats: sp.stats || cat?.item.stats || undefined,
    };
  }

  const entry = INDEX.get(ref);
  if (!entry) return ctx.fail('Item not in the catalog');
  const { item, file } = entry;
  if (isUpgradeFile(file)) {
    const p = priceUpgrade(ctx, actor, file, item, raw || {}, sim);
    const line: OrderLine & Loose = {
      ref, catalogId: item.id, file, name: itemName(item), category: item.categoryFr || item.category, qty: 1, rating: p.q.rating,
      unitCost: p.unitCost, availValue: p.q.availValue, legality: p.q.legality, target: p.target,
    };
    for (const k of ['mount', 'capacity', 'slots', 'effects', 'monthlyDelta', 'monthlyCost', 'lowersRent']) if (p[k] !== undefined) line[k] = p[k];
    if (file !== 'lifestylequalities') line.price = p.q.unitCost; // value of the installed part (resale)
    return line;
  }
  const ware = file === 'cyberware' || file === 'bioware';
  if (ware && raw.grade && !allowedGrades(item).includes(raw.grade)) ctx.fail('Grade « {grade} » not available for {item}', { grade: GRADES[raw.grade as keyof typeof GRADES] ? { t: GRADES[raw.grade as keyof typeof GRADES].label } : raw.grade, item: itemName(item) });
  const q = quote(item, { rating: raw.rating, grade: raw.grade, markup: file === 'lifestyles' ? 0 : shop.markup, price: raw.price });
  const line: OrderLine = {
    ref, catalogId: item.id, file, name: itemName(item), category: item.categoryFr || item.category, qty: file === 'lifestyles' ? Math.min(qty, 24) : qty,
    rating: q.rating, grade: ware ? q.grade || 'standard' : null,
    unitCost: q.unitCost, availValue: q.availValue, legality: q.legality, essence: ware ? q.essence ?? 0 : undefined,
    variablePrice: item.costRange ? true : undefined,
  };
  if (file === 'lifestyles') {
    const nm = str(raw.lifestyleName ?? raw.label, 120);
    if (nm) line.lifestyleName = nm;
    if (raw.primary) line.primary = true;
  }
  return line;
}

/** Resolve all lines of a cart (upgrade lines are checked together against the same simulated targets). */
function resolveLines(ctx: ActionContext, actor: ShopActor, raws: CartLine[]): OrderLine[] {
  const sim: Sim = new Map();
  return raws.map((raw) => {
    const l = resolveLine(ctx, raw || {}, actor, sim);
    if (raw?.setMatrix) l.setMatrix = true;
    return l;
  });
}

function lineFlags(shop: ShopState, l: OrderLine): string[] {
  const f: string[] = [];
  if (l.legality === 'R') f.push('restricted');
  if (l.legality === 'F') f.push('forbidden');
  if (l.availValue! > shop.maxAvail) f.push('avail');
  if (l.variablePrice) f.push('price');
  if (l.lowersRent) f.push('rent');
  return f;
}

/** Player-side shop rules (the GM bypasses them). */
function checkRules(ctx: ActionContext, lines: OrderLine[]): void {
  const shop = ctx.state.shop;
  if (!shop.open) ctx.fail('Cabana can’t be reached right now');
  for (const l of lines) {
    if (l.specialId) continue; // fixer deals are GM-curated
    if (shop.categories[l.file!] === false) ctx.fail('{section}: section closed for now', { section: FILE_LABELS[l.file!] ? { t: FILE_LABELS[l.file!] } : l.file! });
    if (l.availValue! > shop.maxAvail) ctx.fail('{item}: availability {avail} above the limit ({max}) — see the GM', { item: l.name, avail: l.availValue!, max: shop.maxAvail });
    if (l.legality === 'F' && !shop.allowForbidden) ctx.fail('{item} is forbidden: Cabana won’t take the risk', { item: l.name });
    if (l.legality === 'R' && !shop.allowRestricted) ctx.fail('{item} is restricted: no sale without a license for now', { item: l.name });
  }
}

function checkStock(ctx: ActionContext, lines: OrderLine[]): void {
  const need: Record<string, number> = {};
  for (const l of lines) if (l.specialId) need[l.specialId] = (need[l.specialId] || 0) + l.qty;
  for (const [id, n] of Object.entries(need)) {
    const sp = ctx.state.shop.specials.find((s) => s.id === id);
    if (!sp) return ctx.fail('A deal in the order no longer exists');
    if (sp.stock !== null && sp.stock !== undefined && Number(sp.stock) < n) {
      if (sp.stock > 1) ctx.fail('{item}: not enough stock ({n} left)', { item: sp.name, n: sp.stock });
      ctx.fail('one::{item}: not enough stock ({n} left)', { item: sp.name, n: sp.stock });
    }
  }
}

// ---------------------------------------------------------------------------
// Availability tests (SR5 p. 418, rules in client/modules/shop/rules.js)
// ---------------------------------------------------------------------------
const MAX_AVAIL_TESTS = 300;

/** A test with its live outcome: the roll's hits are read from the log (Edge « Seconde chance » rerolls the entry in place). */
function liveTest(state: TableState, test: AvailTest) {
  const e = test.logId ? (state.log || []).find((x) => x.id === test.logId) : null;
  if (typeof e?.roll?.hits === 'number') {
    test.hits = e.roll.hits;
    test.glitch = !!e.roll.glitch;
    test.critGlitch = !!e.roll.critGlitch;
  }
  return { ...test, ...availOutcome(test) };
}

/**
 * Player purchase: the successful tests the lines need, written on the lines (`availTest`). Mode « required » refuses a line
 * without one; « helper » only records the tests that exist. Returns the ids of the tests to mark as used.
 */
function claimAvailTests(ctx: ActionContext, actor: ShopActor, lines: OrderLine[]): string[] {
  const shop = ctx.state.shop;
  const need = lines.map((l) => ({ ref: l.ref, targetId: l.target?.itemId || '', availValue: l.availValue, needsTest: needsAvailTest(shop, { file: l.file, special: !!l.specialId, availValue: l.availValue }) }));
  if (!need.some((n) => n.needsTest)) return [];
  const tests = shop.availTests.filter((x) => x.actorId === actor.id && x.status === 'open').map((x) => liveTest(ctx.state, x));
  const matched = matchAvailTests(need, tests);
  if (shop.availTest === 'required') {
    const i = matched.findIndex((m: unknown, j: number) => need[j].needsTest && !m);
    if (i >= 0) ctx.fail('{item}: pass an availability test first (Availability {avail})', { item: lines[i].name, avail: lines[i].availValue! });
  }
  const ids: string[] = [];
  matched.forEach((m: Loose | null, i: number) => {
    if (!m) return;
    lines[i].availTest = { id: m.id, hits: m.hits, availHits: m.availHits, net: m.net, avail: m.avail, baseHours: m.baseHours, delayHours: m.delayHours, tries: m.tries, ...(m.tie ? { tie: true } : {}), ...(m.glitch ? { glitch: true } : {}), ...(m.contactName ? { contact: m.contactName } : {}), ...(m.overpay ? { overpay: m.overpay } : {}) };
    // Money thrown at the search (SR5 p. 418): +25 % of the item's value per bought die, paid on purchase (unitCost stays the
    // item's price — resale value).
    if (m.overpay) lines[i].surcharge = overpaySurcharge(lines[i].unitCost, m.overpay);
    ids.push(m.id);
  });
  return ids;
}

/**
 * A runner's contact searching for gear (SR5: the contact makes the Availability test with their own Charisma + Negotiation,
 * Connection added to their Social limit). Stats come from an NPC actor, else a bestiary template, with the contact's name.
 * → { id, name, connection, known: false } or { …, known: true, source, cha, negotiation, pool, defaulting, social, limit }
 */
const contactInfo = contactSheet; // shared/contacts.js (also used by the sheet and 'actor/contactRoll')

/** The contact's Availability roll, logged like a dice roll (no runner modifiers, no Edge: it is not the runner's test). */
function contactRoll(ctx: ActionContext, actor: ShopActor, contact: Contact, line: OrderLine, avail: Loose, modifier: unknown, overpay: number) {
  const c: ContactSheet = contactInfo(ctx.state, contact);
  if (!c.known) ctx.fail('{contact} has no stats (Charisma, Negotiation): the GM can create an NPC with this name in the Bestiary', { contact: contact.name });
  const mod = clampInt(modifier, -20, 20, 0);
  const pool = Math.min(100, c.pool! + mod + overpay);
  if (pool <= 0) ctx.fail('Dice pool of zero: automatic failure');
  // Breakdown terms are dictionary keys (rollBreakdown() translates them).
  const parts = c.defaulting ? [`CHA ${c.cha}`, 'defaulting −1'] : [`CHA ${c.cha}`, `Negotiation ${c.negotiation}`];
  if (overpay) parts.push(`overpay +${overpay}`);
  if (mod) parts.push(`mod. ${mod > 0 ? '+' : '−'}${Math.abs(mod)}`);
  const r = rollDice(pool, { limit: c.limit });
  const label = `Availability — ${line.name} (via ${contact.name})`; // English rendering of labelI18n
  const roll: RollRecord = {
    ...r, label, labelI18n: { key: tk('Availability — {item} (via {contact})'), params: { item: line.name, contact: contact.name } },
    explode: false, edge: false, actorId: null, breakdown: parts.join(' + '), limitLabel: 'social',
    limitBreakdown: `social ${c.social} + Connection ${c.connection}`, avail: { ...avail, contact: contact.name } as AvailRollInfo,
  };
  const entry = ctx.log({ kind: 'roll', userId: ctx.user.id, author: actor.name, text: label, roll });
  ctx.emitTo('all', 'sfx', { id: 'dice' });
  return { ...roll, logId: entry.id };
}

/** Tests used by an order (status 'used'), or given back when the order is denied / cancelled. */
function useTests(shop: ShopState, ids: string[], orderId: string): void {
  for (const x of shop.availTests) if (ids.includes(x.id)) Object.assign(x, { status: 'used', orderId });
}
function releaseTests(shop: ShopState, orderId: string): void {
  for (const x of shop.availTests) {
    if (x.orderId !== orderId) continue;
    x.status = 'open';
    delete x.orderId;
  }
}

const essenceCost = (lines: OrderLine[]): number => round3(lines.reduce((s, l) => s + (l.essence ? l.essence * l.qty : 0), 0));

function checkEssence(ctx: ActionContext, actor: ShopActor, lines: OrderLine[]): void {
  const cost = essenceCost(lines);
  if (cost <= 0) return;
  const ess = Number(actor.attributes?.ESS ?? 6);
  if (ess - cost <= 0) ctx.fail('Insufficient Essence: {ess} − {cost} would kill {name}', { ess, cost, name: actor.name });
}

function checkFunds(ctx: ActionContext, actor: ShopActor, total: number): void {
  const have = Number(actor.nuyen) || 0;
  if (have < total) ctx.fail('Insufficient funds: {cost} needed, {have} available', { cost: nuyen(total), have: nuyen(have) });
}

// ---------------------------------------------------------------------------
// Applying purchases to the actor
// ---------------------------------------------------------------------------
// applyBonus / removeBonus / weaponFromStats live in server/lib/augment.js (shared with the sheet editor).

const evalStat = (v: unknown, rating?: number | null): number => {
  if (typeof v === 'number') return v;
  try {
    return Math.round(evalFormula(v, { Rating: rating ?? 1 }));
  } catch {
    return 0;
  }
};

/** Sub-item copied from an accessory catalog item (weapon.accessories[]). */
function accessoryItem(ctx: Pick<ActionContext, 'uid'>, accItem: Cat, extra: Loose): Loose {
  const a: Loose = { id: ctx.uid('acc'), catalogId: accItem.id, name: accItem.name, mount: '', cost: 0, avail: accItem.avail || '' };
  if (accItem.nameFr) a.nameFr = accItem.nameFr;
  const effects = accessoryEffects(accItem);
  if (Object.keys(effects).length) a.effects = effects;
  if (Array.isArray(accItem.stats?.extraMount) && accItem.stats.extraMount.length) a.extraMount = [...accItem.stats.extraMount];
  return Object.assign(a, extra);
}

/** Install an upgrade line on its (real) target. Re-checks the fit (a pending order may be approved later). */
function installUpgrade(ctx: ActionContext, actor: ShopActor, line: OrderLine, { paid }: { paid?: number }): Note[] {
  const entry = INDEX.get(line.catalogId as string);
  if (!entry || !isUpgradeFile(entry.file)) return ctx.fail('Item not in the catalog');
  const { item, file } = entry;
  const { list, sub } = UPGRADE_FILES[file as keyof typeof UPGRADE_FILES] as { list: string; sub: string };
  const target: Loose | undefined = (Array.isArray(actor[list]) ? actor[list] : []).find((x: Loose) => x && x.id === line.target?.itemId);
  if (!target) return ctx.fail('Target item not found');
  if (!Array.isArray(target[sub])) target[sub] = [];
  const cat = list === 'lifestyles' ? null : catalogOf(target)?.item || null;
  const extra = { ...(paid !== undefined ? { paid } : {}) };
  if (file === 'lifestylequalities') {
    const problem = qualityProblem(target, item, catalogItem);
    if (problem) failWith(ctx, problem);
    target.qualities.push(qualityFromCatalog(item, { id: ctx.uid('lsq'), cost: line.monthlyCost ?? quote(item, { markup: 0 }).base }));
    settleLifestyles(actor);
  } else if (file === 'accessories') {
    if (!Array.isArray(target.mounts) && Array.isArray(cat?.stats?.mounts)) target.mounts = [...cat.stats.mounts];
    const fit = accessoryFit(target, cat, item, { mount: line.mount });
    if (fit.problem) failWith(ctx, fit.problem);
    target.accessories.push(accessoryItem(ctx, item, { mount: fit.mount, cost: line.price ?? line.unitCost, ...(line.rating ? { rating: line.rating } : {}), ...extra }));
  } else if (file === 'armormods') {
    if ((target.capacity === undefined || target.capacity === null) && cat?.stats?.capacity !== undefined) target.capacity = Number(cat.stats.capacity) || 0;
    const fit = armorModFit(target, cat, item, line.rating);
    if (fit.problem) failWith(ctx, fit.problem);
    const m: Loose = { id: ctx.uid('mod'), catalogId: item.id, name: item.name, capacity: fit.need, cost: line.price ?? line.unitCost, avail: item.avail || '', ...extra };
    if (item.nameFr) m.nameFr = item.nameFr;
    if (line.rating) m.rating = line.rating;
    if (item.stats?.armor) m.effects = { armor: Number(item.stats.armor) || 0 };
    if (item.stats?.bonus && Object.keys(item.stats.bonus).length) {
      m.bonus = {};
      for (const [k, v] of Object.entries(item.stats.bonus)) m.bonus[k] = typeof v === 'string' ? evalStat(v, line.rating) : v;
    }
    target.mods.push(m);
  } else {
    const vars = vehicleVars(target, cat, baseValue(target) ?? 0);
    const fit = vehicleModFit(target, cat, item, line.rating, vars);
    if (fit.problem) failWith(ctx, fit.problem);
    const m: Loose = { id: ctx.uid('mod'), catalogId: item.id, name: item.name, slots: fit.need, category: item.category || '', cost: line.price ?? line.unitCost, avail: item.avail || '', ...extra };
    if (item.nameFr) m.nameFr = item.nameFr;
    if (line.rating) m.rating = line.rating;
    const effects = vehicleModEffects(item, line.rating, vars);
    if (Object.keys(effects).length) m.effects = effects;
    target.mods.push(m);
  }
  return [];
}

/** Add one priced line to the actor. paid = unit price actually paid (undefined for GM gifts). Returns notes [{ key, params }]. */
function addLine(ctx: ActionContext, actor: ShopActor, line: OrderLine, { paid }: { paid?: number }): Note[] {
  const entry = line.catalogId ? INDEX.get(line.catalogId) : null;
  const item: Loose = entry?.item || { stats: line.stats || {} };
  const st: Loose = line.stats || item.stats || {};
  const list = targetList(line.file, { stats: st });
  const notes: Note[] = [];
  const base: { catalogId?: string; paid?: number } = { catalogId: line.catalogId || undefined };
  if (paid !== undefined) base.paid = paid;

  if (list === 'upgrade') return installUpgrade(ctx, actor, line, { paid: paid !== undefined ? line.price ?? paid : undefined });
  if (list === 'lifestyles') {
    actor.lifestyles = Array.isArray(actor.lifestyles) ? actor.lifestyles : [];
    const primary = !actor.lifestyles.length || !!line.primary;
    const l = lifestyleFromCatalog(entry?.item || { name: line.name, cost: line.unitCost }, { id: ctx.uid('ls'), name: line.lifestyleName || line.name, months: line.qty, primary });
    if (primary) for (const o of actor.lifestyles) o.primary = false;
    actor.lifestyles.push(l);
    settleLifestyles(actor);
    return notes;
  }
  for (const key of ['weapons', 'armor', 'augmentations', 'gear', 'vehicles']) if (!Array.isArray(actor[key])) actor[key] = [];

  if (list === 'weapons') {
    for (let i = 0; i < line.qty; i++) {
      const w: Loose = weaponFromStats(ctx, line.name, line.category, st, base);
      if (Array.isArray(st.mounts)) w.mounts = [...st.mounts];
      // Accessories delivered with the weapon (Chummer <accessories>): installed, included in the price.
      const included = (st.included || []).map((inc: { id?: string; name?: string }) => {
        const acc = inc.id ? INDEX.get(inc.id)?.item : null;
        return acc ? accessoryItem(ctx, acc, { mount: 'Internal', included: true }) : { id: ctx.uid('acc'), name: inc.name, mount: 'Internal', included: true, cost: 0 };
      });
      if (included.length) w.accessories = included;
      actor.weapons.push(w);
    }
  } else if (list === 'armor') {
    for (let i = 0; i < line.qty; i++) {
      const a: Loose = { id: ctx.uid('arm'), name: line.name, rating: evalStat(st.armor ?? 0, line.rating), equipped: false, stack: !!st.stack || undefined, ...base };
      if (st.capacity !== undefined) a.capacity = Number(st.capacity) || 0;
      actor.armor.push(a);
    }
  } else if (list === 'augmentations') {
    for (let i = 0; i < line.qty; i++) {
      const aug: Loose = {
        id: ctx.uid('aug'),
        name: line.name,
        kind: st.kind || (line.file === 'bioware' ? 'bioware' : 'cyberware'),
        grade: line.grade || 'standard',
        essence: line.essence || 0,
        ...base,
      };
      if (line.rating) aug.rating = line.rating;
      // Essence loss (and Magic/Resonance loss for awakened/emerged characters).
      if (aug.essence > 0) {
        actor.attributes = actor.attributes || {};
        const before = Number(actor.attributes.ESS ?? 6);
        const after = round3(before - aug.essence);
        actor.attributes.ESS = after;
        const loss = magicLoss(before, after);
        for (const k of ['MAG', 'RES']) {
          if (loss && Number(actor.attributes[k]) > 0) {
            actor.attributes[k] = Math.max(0, Number(actor.attributes[k]) - loss);
            if (k === 'MAG') notes.push({ key: tk('Magic −{n}'), params: { n: loss } });
            else notes.push({ key: tk('Resonance −{n}'), params: { n: loss } });
          }
        }
      }
      // Attribute / initiative dice / initiative score bonus (catalog effects, else stats.bonus), recorded on aug.bonus.
      bakeItemBonus(actor as Actor, 'augmentations', aug, st.bonus);
      if (st.weapon) actor.weapons.push(weaponFromStats(ctx, line.name, line.category, st.weapon, { augId: aug.id, catalogId: line.catalogId || undefined }));
      actor.augmentations.push(aug);
    }
  } else if (list === 'vehicles') {
    for (let i = 0; i < line.qty; i++) {
      actor.vehicles.push({
        id: ctx.uid('veh'), name: line.name, handling: st.handling ?? 0, speed: st.speed ?? 0, accel: st.accel ?? 0, body: st.body ?? 0,
        armor: st.armor ?? 0, pilot: st.pilot ?? 0, sensor: st.sensor ?? 0, seats: st.seats ?? undefined, notes: line.category || undefined, ...base,
      });
    }
  } else {
    // Gear (stackable). Ammunition and similar are sold per pack of `costFor` units.
    const per = Number(st.costFor) || 1;
    const units = line.qty * per;
    const unitPaid = paid !== undefined ? Math.round((paid / per) * 100) / 100 : undefined;
    const isDevice = DEVICE_GEAR.has(item.category) || line.setMatrix;
    const same = !isDevice && actor.gear.find((g: Loose) => (line.catalogId ? g.catalogId === line.catalogId : !g.catalogId && g.name === line.name) && (g.rating ?? null) === (line.rating ?? null));
    let gearItem: Loose;
    if (same) {
      const oldQty = Number(same.qty) || 0;
      if (unitPaid !== undefined && same.paid !== undefined) same.paid = Math.round(((same.paid * oldQty + unitPaid * units) / (oldQty + units)) * 100) / 100;
      else if (unitPaid !== undefined && !oldQty) same.paid = unitPaid;
      same.qty = oldQty + units;
      gearItem = same;
    } else {
      gearItem = { id: ctx.uid('gear'), name: line.name, category: line.category || '', qty: units, ...base };
      if (unitPaid !== undefined) gearItem.paid = unitPaid;
      if (line.rating) gearItem.rating = line.rating;
      actor.gear.push(gearItem);
    }
    if (line.file === 'programs' && actor.matrix) {
      actor.matrix.programs = Array.isArray(actor.matrix.programs) ? actor.matrix.programs : [];
      if (!actor.matrix.programs.includes(line.name)) actor.matrix.programs.push(line.name);
    }
    if (line.setMatrix && (st.deviceRating !== undefined || st.attributeArray || st.dataProcessing !== undefined)) {
      const arr = Array.isArray(st.attributeArray) ? st.attributeArray : null;
      actor.matrix = {
        device: line.name,
        rating: evalStat(st.deviceRating ?? 0, line.rating),
        attack: arr ? arr[0] : st.attack ?? 0,
        sleaze: arr ? arr[1] : st.sleaze ?? 0,
        dataProcessing: arr ? arr[2] : st.dataProcessing ?? evalStat(st.deviceRating ?? 0, line.rating),
        firewall: arr ? arr[3] : st.firewall ?? evalStat(st.deviceRating ?? 0, line.rating),
        programs: Array.isArray(actor.matrix?.programs) ? actor.matrix.programs : [],
        gearId: gearItem.id,
      };
      notes.push({ key: tk('{item} becomes the Matrix device'), params: { item: line.name } });
    }
  }
  return notes;
}

/** Apply a buy/give order to its actor (nuyen, items, stock). Returns notes [{ key, params }]. */
function applyOrder(ctx: ActionContext, actor: ShopActor, order: ShopOrder, { free = false }: { free?: boolean } = {}): Note[] {
  const notes: Note[] = [];
  for (const line of order.items) {
    notes.push(...addLine(ctx, actor, line, { paid: free ? undefined : (line.unitCost ?? undefined) })); // buy / give lines are always priced
    if (line.availTest?.delayHours) {
      const p = { item: line.name, delay: durationText(line.availTest.delayHours) as I18nMessage };
      if (line.surcharge) notes.push({ key: tk('{item}: found in {delay} (overpay {cost})'), params: { ...p, cost: nuyen(line.surcharge * line.qty) } });
      else notes.push({ key: tk('{item}: found in {delay}'), params: p });
    }
    if (line.specialId) {
      const sp = ctx.state.shop.specials.find((s) => s.id === line.specialId);
      if (sp && sp.stock !== null && sp.stock !== undefined) sp.stock = Math.max(0, Number(sp.stock) - line.qty);
    }
  }
  fillActorRefs(actor); // 📖 source / page of the new items (catalog)
  thrownGearToWeapons(actor, (p?: string) => ctx.uid(p)); // grenades / Molotovs bought as gear: throwable weapons
  if (!free) actor.nuyen = (Number(actor.nuyen) || 0) - order.total!;
  const items = summary(order.items);
  const np = notesParam(notes);
  if (free) {
    if (notes.length) history(actor, tk('Received from the GM: {items} ({notes})'), { items, notes: np }, 0);
    else history(actor, tk('Received from the GM: {items}'), { items }, 0);
    shopLog(ctx, actor.id, tk('{actor} receives: {items}'), { actor: actor.name, items });
  } else {
    const cost = nuyen(order.total);
    if (notes.length) {
      history(actor, tk('Purchase: {items} ({notes})'), { items, notes: np }, -order.total!);
      shopLog(ctx, actor.id, tk('{actor} buys: {items} — {cost} · {notes}'), { actor: actor.name, items, cost, notes: np });
    } else {
      history(actor, tk('Purchase: {items}'), { items }, -order.total!);
      shopLog(ctx, actor.id, tk('{actor} buys: {items} — {cost}'), { actor: actor.name, items, cost });
    }
  }
  notifyOwners(ctx, actor.id, 'sfx', { id: 'cash' });
  return notes;
}

// ---------------------------------------------------------------------------
// Selling
// ---------------------------------------------------------------------------
/** Value (100%) of an installed accessory / mod: price paid, else its recorded catalog price. Included parts: 0. */
function subValue(s: Loose | null | undefined): number {
  if (!s || s.included) return 0;
  if (Number.isFinite(Number(s.paid)) && s.paid !== null && s.paid !== '') return Number(s.paid);
  return Math.max(0, Number(s.cost) || 0);
}

/** Full (100%) unit value of an owned item (installed accessories/mods included), or null if unknown. */
function itemValue(list: string, it: Loose): number | null {
  const subs = SUB_OF[list] && list !== 'lifestyles' && Array.isArray(it[SUB_OF[list]]) ? it[SUB_OF[list]].reduce((s: number, x: Loose) => s + subValue(x), 0) : 0;
  if (Number.isFinite(Number(it.paid)) && it.paid !== null && it.paid !== '') return Number(it.paid) + subs;
  const entry = catalogOf(it);
  if (!entry) return subs ? subs : null;
  try {
    const q = quote(entry.item, { rating: it.rating, grade: it.grade });
    const per = list === 'gear' ? Number(entry.item.stats?.costFor) || 1 : 1;
    return Math.round((q.unitCost / per) * 100) / 100 + subs;
  } catch {
    return null;
  }
}

function findOwned(ctx: ActionContext, actor: ShopActor, list: unknown, itemId: unknown): Loose {
  if (!LISTS.includes(list as string)) ctx.fail('Invalid list');
  const arr: Loose[] = Array.isArray(actor[list as string]) ? actor[list as string] : [];
  const it = arr.find((x) => x.id === itemId);
  if (!it) return ctx.fail('Item not found in the inventory');
  return it;
}

/** Installed accessory / mod of an owned item. */
function findSub(ctx: ActionContext, it: Loose, list: string, subId: unknown): Loose {
  const sub = SUB_OF[list];
  if (!sub || list === 'lifestyles') ctx.fail('Invalid list');
  const s: Loose | undefined = (Array.isArray(it[sub]) ? it[sub] : []).find((x: Loose) => x && x.id === subId);
  if (!s) return ctx.fail('Option not found');
  return s;
}

function applySell(ctx: ActionContext, actor: ShopActor, order: ShopOrder): void {
  const line = order.items[0];
  const it = findOwned(ctx, actor, line.list, line.itemId);
  const list = line.list as string;
  if (line.subId) {
    const s = findSub(ctx, it, list, line.subId);
    if (s.included) ctx.fail('Built-in part of {item}: it goes with it', { item: it.name });
    it[SUB_OF[list]] = it[SUB_OF[list]].filter((x: Loose) => x.id !== s.id);
  } else {
    if (list === 'weapons' && it.augId) ctx.fail('Weapon built into an implant: sell the implant itself');
    if (list === 'gear') {
      const have = Math.max(0, Number(it.qty ?? 1) || 0);
      if (have < 1) ctx.fail('No copy of {item} left to sell', { item: it.name });
      if (line.qty > have) ctx.fail('Only {n} {item} left', { n: have, item: it.name });
      if (line.qty < have) it.qty = have - line.qty;
      else actor.gear = actor.gear.filter((g: Loose) => g.id !== it.id);
    } else {
      actor[list] = actor[list].filter((x: Loose) => x.id !== it.id);
    }
    if (list === 'augmentations') {
      removeBonus(actor as Actor, it.bonus);
      if (Array.isArray(actor.weapons)) actor.weapons = actor.weapons.filter((w: Loose) => w.augId !== it.id);
    }
    if (list === 'gear' && actor.matrix?.gearId === it.id && !actor.gear.some((g: Loose) => g.id === it.id)) {
      actor.matrix = { ...actor.matrix, device: '', rating: 0, attack: 0, sleaze: 0, dataProcessing: 0, firewall: 0 };
      delete actor.matrix.gearId;
    }
  }
  actor.nuyen = (Number(actor.nuyen) || 0) + order.total!;
  const item = line.subId ? lineText({ name: line.name, target: { name: it.name } }) : lineText({ name: line.name, qty: line.qty });
  history(actor, tk('Resale: {item}'), { item }, order.total!);
  shopLog(ctx, actor.id, tk('{actor} sells {item} — {cost}'), { actor: actor.name, item, cost: nuyen(order.total) });
  notifyOwners(ctx, actor.id, 'sfx', { id: 'cash' });
}

// ---------------------------------------------------------------------------
// Martial arts (karma; Run & Gun p.128 — a style includes its first technique)
// ---------------------------------------------------------------------------
/** Validate a martial art request → { style, existing, techniques (new catalog techniques), karma }. */
function martialPlan(ctx: ActionContext, actor: ShopActor, styleId: unknown, techniqueIds: unknown) {
  const style = MARTIAL.get(str(styleId, 80));
  if (!style) return ctx.fail('Unknown martial art');
  const known: Loose | undefined = (Array.isArray(actor.martialArts) ? actor.martialArts : []).find((m: Loose) => m.catalogId === style.id);
  const ids = [...new Set((Array.isArray(techniqueIds) ? techniqueIds : []).map((x) => str(x, 80)).filter(Boolean))].slice(0, 20);
  const techs = ids.map((id) => {
    const t: Loose | undefined = (style.stats?.techniques || []).find((x: Loose) => x.id === id);
    if (!t) return ctx.fail('Unknown technique for {style}', { style: itemName(style) });
    return t;
  });
  const fresh = techs.filter((t) => !(known?.techniques || []).some((k: Loose) => k.catalogId === t.id));
  if (known && !fresh.length) ctx.fail('Nothing new to learn');
  const karma = martialKarma(style, known || null, fresh.length);
  return { style, known, techniques: fresh, karma };
}

/** Grant a martial art plan to an actor (karma deducted unless free). */
function applyMartial(ctx: ActionContext, actor: ShopActor, plan: ReturnType<typeof martialPlan>, { free }: { free: boolean }): Loose {
  if (!free && (Number(actor.karma) || 0) < plan.karma) ctx.fail('Not enough karma: {cost} needed, {have} available', { cost: plan.karma, have: Number(actor.karma) || 0 });
  actor.martialArts = Array.isArray(actor.martialArts) ? actor.martialArts : [];
  let m: Loose = actor.martialArts.find((x: Loose) => x.catalogId === plan.style.id);
  if (!m) {
    m = { id: ctx.uid('ma'), catalogId: plan.style.id, name: itemName(plan.style), rating: 1, techniques: [] };
    actor.martialArts.push(m);
  }
  if (!Array.isArray(m.techniques)) m.techniques = [];
  for (const t of plan.techniques) {
    const tech: Loose = { id: ctx.uid('tec'), catalogId: t.id, name: t.name };
    if (t.nameFr) tech.nameFr = t.nameFr;
    m.techniques.push(tech);
  }
  fillActorRefs(actor);
  const names = plan.techniques.map((t) => t.nameFr || t.name).join(', ');
  const params = { style: m.name, techniques: names || '—', karma: free ? 0 : plan.karma };
  if (!free) actor.karma = (Number(actor.karma) || 0) - plan.karma;
  history(actor, tk('Martial art: {style} ({techniques})'), params, 0, free ? 0 : -plan.karma);
  shopLog(ctx, actor.id, tk('{actor} learns {style} ({techniques}) — {karma} karma'), { actor: actor.name, ...params });
  notifyOwners(ctx, actor.id, 'sfx', { id: 'level-up' });
  return m;
}

// ---------------------------------------------------------------------------
// Specials (fixer deals)
// ---------------------------------------------------------------------------
function sanitizeSpecial(ctx: ActionContext, src: Loose, prev: Partial<ShopSpecial> = {}): ShopSpecial {
  const out: Loose = { ...prev };
  const fileOk = (f: unknown) => SHOP_FILES.includes(f as CatalogFile) && !isUpgradeFile(f as string);
  if (src.name !== undefined) out.name = str(src.name, 120) || prev.name || ctx.t('Unnamed deal'); // stored in the table language
  if (src.category !== undefined) out.category = str(src.category, 60);
  if (src.file !== undefined) out.file = fileOk(src.file) ? src.file : 'gear';
  if (src.cost !== undefined) out.cost = Math.max(0, int(src.cost));
  if (src.avail !== undefined) {
    const a = parseAvailString(src.avail);
    out.avail = `${a.value}${a.legality}`;
  }
  if (src.stock !== undefined) out.stock = src.stock === null || src.stock === '' ? null : Math.max(0, int(src.stock));
  if (src.notes !== undefined) out.notes = str(src.notes, 2000);
  if (src.gmNotes !== undefined) out.gmNotes = str(src.gmNotes, 2000);
  if (src.hidden !== undefined) out.hidden = !!src.hidden;
  if (src.forActorIds !== undefined) out.forActorIds = Array.isArray(src.forActorIds) ? src.forActorIds.filter((id: unknown) => typeof id === 'string').slice(0, 20) : [];
  if (src.rating !== undefined) out.rating = src.rating === null || src.rating === '' ? null : Math.max(0, int(src.rating));
  if (src.grade !== undefined) out.grade = GRADES[src.grade as keyof typeof GRADES] ? src.grade : 'standard';
  if (src.essence !== undefined) out.essence = src.essence === null || src.essence === '' ? null : Math.max(0, round3(Number(src.essence) || 0));
  if (src.catalogRef !== undefined) out.catalogRef = src.catalogRef && INDEX.has(src.catalogRef) && !isUpgradeFile(INDEX.get(src.catalogRef)!.file) ? src.catalogRef : null;
  if (src.stats !== undefined && src.stats && typeof src.stats === 'object') out.stats = JSON.parse(JSON.stringify(src.stats));
  if (src.originalCost !== undefined) out.originalCost = src.originalCost === null ? null : Math.max(0, int(src.originalCost));
  if (!out.file) out.file = out.catalogRef ? INDEX.get(out.catalogRef)?.file || 'gear' : 'gear';
  if (out.stock === undefined) out.stock = null;
  if (!out.avail) out.avail = '0';
  if (out.cost === undefined) out.cost = 0;
  return out as ShopSpecial;
}

// ---------------------------------------------------------------------------
// Historic upgrades restore (data/seed/upgrades-restore.json): lifestyle qualities, weapon accessories and armor
// mods the characters had in Chummer, lost on the way Chummer → Foundry → app. Applied once per actor.
// ---------------------------------------------------------------------------
function matchItem(list: unknown, spec: Loose): Loose | null {
  if (!Array.isArray(list)) return null;
  if (spec.catalogId) {
    const byId = list.find((x: Loose) => x && x.catalogId === spec.catalogId);
    if (byId) return byId;
  }
  const m = fold(spec.match || '');
  return m ? list.find((x: Loose) => x && fold(x.name).includes(m)) || null : null;
}

/** Apply the restore spec of one actor. Returns the number of upgrades added. */
export function restoreUpgrades(actor: ShopActor, spec: Loose, makeId: (prefix: string) => string): number {
  let added = 0;
  const NOTE = String(spec.note || 'Chummer').slice(0, 500);
  if (spec.lifestyleNote && Array.isArray(actor.lifestyles)) {
    // Historic lifestyle kept as a note only (e.g. a retired PC whose current lifestyle differs from the Chummer one).
    const l = primaryLifestyle(actor);
    const note = String(spec.lifestyleNote).slice(0, 1500);
    if (l && !String(l.notes || '').includes(note.slice(0, 60))) l.notes = (l.notes ? `${l.notes}

` : '') + note;
  }
  if (spec.lifestyle && Array.isArray(actor.lifestyles)) {
    const l = matchItem(actor.lifestyles, spec.lifestyle);
    if (l && !(l.qualities || []).length) {
      const baseItem = [...INDEX.values()].find((e) => e.file === 'lifestyles' && e.item.name === spec.lifestyle.base)?.item;
      if (baseItem) {
        l.base = baseOf(baseItem.name);
        l.catalogId ||= baseItem.id;
        l.baseCost = Math.round(Number(baseItem.cost) || 0);
      }
      l.qualities = [];
      for (const id of spec.lifestyle.qualities || []) {
        const it = INDEX.get(id)?.item;
        if (!it) continue;
        l.qualities.push(qualityFromCatalog(it, { id: makeId('lsq'), cost: quote(it, { markup: 0 }).base, notes: NOTE }));
        added++;
      }
      settleLifestyles(actor);
    }
  }
  const ctx = { uid: makeId };
  for (const w of spec.weapons || []) {
    const weapon = matchItem(actor.weapons, w);
    if (!weapon) continue;
    const cat = catalogOf(weapon)?.item;
    if (!Array.isArray(weapon.mounts) && Array.isArray(cat?.stats?.mounts)) weapon.mounts = [...cat.stats.mounts];
    weapon.accessories = Array.isArray(weapon.accessories) ? weapon.accessories : [];
    for (const a of w.accessories || []) {
      const it = INDEX.get(a.id)?.item;
      if (!it || weapon.accessories.some((x: Loose) => x.catalogId === it.id)) continue;
      weapon.accessories.push(accessoryItem(ctx, it, { mount: a.mount ?? '', ...(a.included ? { included: true } : { cost: Number(it.cost) || 0 }), notes: NOTE }));
      added++;
    }
  }
  for (const s of spec.armor || []) {
    const armor = matchItem(actor.armor, s);
    if (!armor) continue;
    const cat = catalogOf(armor)?.item;
    if ((armor.capacity === undefined || armor.capacity === null) && cat?.stats?.capacity !== undefined) armor.capacity = Number(cat.stats.capacity) || 0;
    armor.mods = Array.isArray(armor.mods) ? armor.mods : [];
    for (const m of s.mods || []) {
      const it = INDEX.get(m.id)?.item;
      if (!it || armor.mods.some((x: Loose) => x.catalogId === it.id)) continue;
      const cap = armorCapacity(armor, cat);
      const q = quote(it, { rating: m.rating, vars: { ArmorCost: Number(cat?.cost) || 0, Capacity: cap } });
      const mod: Loose = { id: makeId('mod'), catalogId: it.id, name: it.name, capacity: armorModFit({ ...armor, mods: [] }, cat, it, q.rating).need, cost: q.unitCost, avail: it.avail || '', notes: NOTE };
      if (it.nameFr) mod.nameFr = it.nameFr;
      if (q.rating) mod.rating = q.rating;
      // The stored armor rating came from Foundry and already counts the mod's armor bonus: no effects.armor here.
      if (it.stats?.armor && !s.ratingIncludesMods) mod.effects = { armor: Number(it.stats.armor) || 0 };
      armor.mods.push(mod);
      added++;
    }
  }
  return added;
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Action payloads (players send most of them: every field is validated by the handlers)
// ---------------------------------------------------------------------------
interface BuyPayload {
  actorId?: ActorId;
  items?: CartLine[];
}
interface AvailTestPayload {
  actorId?: ActorId;
  item?: CartLine;
  useSpec?: boolean;
  /** Edge: Push the Limit. */
  explode?: boolean;
  modifier?: number;
  contactId?: string;
  overpay?: number;
}
interface GivePayload extends CartLine {
  actorId?: ActorId;
  items?: CartLine[];
}
interface SellPayload {
  actorId?: ActorId;
  list?: string;
  itemId?: string;
  subId?: string;
  qty?: number;
  /** GM: total override. */
  price?: number | string | null;
}
interface RemoveUpgradePayload {
  actorId?: ActorId;
  list?: string;
  itemId?: string;
  subId?: string;
}
interface ResolvePayload {
  orderId?: string;
  approve?: boolean;
  note?: string;
  /** Override (negotiated price). */
  total?: number | string | null;
}
interface OrderPayload {
  orderId?: string;
}
interface MartialArtPayload {
  actorId?: ActorId;
  styleId?: string;
  techniqueIds?: string[];
  /** GM: no karma. */
  free?: boolean;
}
interface SettingsPayload {
  open?: boolean;
  markup?: number;
  sellRate?: number;
  maxAvail?: number;
  allowRestricted?: boolean;
  allowForbidden?: boolean;
  approval?: string;
  availTest?: string;
  availFree?: number;
  categories?: Record<string, boolean>;
}
interface AddSpecialPayload {
  special?: Loose;
  fromRef?: string;
  rating?: number;
  grade?: string;
  [field: string]: unknown;
}
interface UpdateSpecialPayload {
  id?: string;
  patch?: Loose;
}
interface IdPayload {
  id?: string;
}
interface PayLifestylePayload {
  actorId?: ActorId;
  /** Default: primary. */
  lifestyleId?: string;
  months?: number;
}
interface MovePayload {
  actorId?: ActorId;
  lifestyleId?: string;
  /** HOME_LAYOUTS id (the flat). */
  layout?: string | null;
  /** Spot on the city map (cells). */
  x?: number | null;
  y?: number | null;
}

/**
 * Choose or change a lifestyle's home: the flat (`layout`) and / or its spot on the city map (`x`, `y`). Setting either
 * for the first time is free; changing one that is already set is a move and costs one fee (homeMoveCost: a month of
 * the level's base rent), even when both change. The GM moves runners for free. A new spot forgets the GM's invitations.
 */
function moveHome(ctx: ActionContext, { actorId, lifestyleId, layout, x, y }: MovePayload) {
  const actor = getActor(ctx, actorId);
  const lf: Loose | undefined = (actor.lifestyles || []).find((l: Loose) => l.id === lifestyleId);
  if (!lf) return ctx.fail('Lifestyle not found');
  const wantsLayout = layout !== undefined && layout !== null && layout !== '';
  const wantsPlace = x !== undefined && x !== null && y !== undefined && y !== null;
  if (!wantsLayout && !wantsPlace) ctx.fail('Nothing to change');
  let next = null;
  if (wantsLayout) {
    next = typeof layout === 'string' && Object.prototype.hasOwnProperty.call(HOME_LAYOUTS, layout) ? HOME_LAYOUTS[layout as keyof typeof HOME_LAYOUTS] : null;
    if (!next || !next.bases.includes(String(lf.base || ''))) return ctx.fail('This home does not match this lifestyle');
  }
  let place = null;
  if (wantsPlace) {
    const city = activeCity(ctx.state);
    if (!city) return ctx.fail('There is no city map on this table');
    place = placeAt(city, x, y, ctx.now);
    if (!place) return ctx.fail('Invalid position');
  }
  const current = homeLayout(lf);
  const curPlace = lf.place && Number.isFinite(lf.place.x) ? lf.place : null;
  const layoutChange = !!next && next.id !== current?.id;
  const placeChange = !!place && !samePlace(place, curPlace);
  if (!layoutChange && !placeChange) ctx.fail('You already live here');
  const isMove = (layoutChange && !!current) || (placeChange && !!curPlace);
  const fee = isMove && !ctx.isGM ? homeMoveCost(lf) : 0;
  if (fee > 0) {
    checkFunds(ctx, actor, fee);
    actor.nuyen = (Number(actor.nuyen) || 0) - fee;
    history(actor, tk('Moving: {name}'), { name: lf.name }, -fee);
    notifyOwners(ctx, actorId as ActorId, 'sfx', { id: 'cash' });
  }
  const moves = (Number(lf.home?.moves) || 0) + (isMove ? 1 : 0);
  if (layoutChange) lf.home = { layout: next!.id, since: ctx.now, moves };
  else if (lf.home && isMove) lf.home = { ...lf.home, since: ctx.now, moves };
  if (placeChange) lf.place = place;
  if (isMove) shopLog(ctx, actorId as ActorId, fee ? tk('{actor} moves ({name}) — {cost}') : tk('{actor} moves ({name})'), { actor: actor.name, name: lf.name, cost: nuyen(fee) });
  else shopLog(ctx, actorId as ActorId, tk('{actor} moves in ({name})'), { actor: actor.name, name: lf.name });
  return { layout: lf.home?.layout ?? null, place: lf.place ?? null, fee };
}

const mod: ServerModule = {
  name: 'shop',

  init(state, { readSeed }) {
    const d = defaults();
    state.shop = state.shop && typeof state.shop === 'object' ? state.shop : ({} as ShopState);
    const shop = state.shop;
    const loose = shop as unknown as Loose;
    for (const [k, v] of Object.entries(d)) if (loose[k] === undefined) loose[k] = v;
    shop.categories = { ...d.categories, ...(shop.categories || {}) };
    if (!Array.isArray(shop.specials)) shop.specials = [];
    if (!Array.isArray(shop.orders)) shop.orders = [];
    if (!Array.isArray(shop.availTests)) shop.availTests = [];
    if (!AVAIL_TEST_MODES.includes(shop.availTest)) shop.availTest = d.availTest;
    if (!Array.isArray(shop.removedSeedIds)) shop.removedSeedIds = [];
    const seed = readSeed<{ specials?: ShopSpecial[] }>('shop.json', { specials: [] }) || {};
    for (const sp of seed.specials || []) {
      if (!sp?.id || shop.specials.some((s) => s.id === sp.id) || shop.removedSeedIds.includes(sp.id)) continue;
      shop.specials.push({ stock: null, ...JSON.parse(JSON.stringify(sp)) });
    }
    // Lifestyles: the characters module migrated actor.lifestyle → actor.lifestyles[] (normalizeActor); keep costs derived.
    for (const a of Object.values(state.actors || {}) as ShopActor[]) {
      if (a && typeof a === 'object' && a.lifestyle && typeof a.lifestyle === 'object' && !Array.isArray(a.lifestyles)) {
        // Safety net when the characters module did not run its migration (e.g. module order changed).
        a.lifestyles = [{ id: `ls_${a.id}`, name: String(a.lifestyle.name || 'Lifestyle').slice(0, 120), base: '', baseCost: Math.max(0, Number(a.lifestyle.monthlyCost) || 0), monthsPaid: Math.max(0, Math.round(Number(a.lifestyle.monthsPaid) || 0)), primary: true, qualities: [], notes: '' }];
        delete a.lifestyle;
      }
      if (a && Array.isArray(a.lifestyles)) {
        // Options stored before `baseOnly` existed (Extra Secure: % of the base cost only) get the catalog flag.
        for (const l of a.lifestyles) for (const q of Array.isArray(l?.qualities) ? l.qualities : []) if (q && q.baseOnly === undefined && q.catalogId && catalogItem(q.catalogId)?.stats?.baseOnly) q.baseOnly = true;
        settleLifestyles(a);
      }
    }
    // Historic upgrades (once per actor).
    const restore = readSeed<{ actors?: Record<ActorId, Loose> } | null>('upgrades-restore.json', null);
    if (restore?.actors) {
      shop.restored = Array.isArray(shop.restored) ? shop.restored : [];
      let n = 0;
      for (const [id, spec] of Object.entries(restore.actors)) {
        const a = state.actors?.[id];
        if (!a || shop.restored.includes(id)) continue;
        // inferred = a guess, not a Chummer file (Anthony): never applied on boot, only by tools/restore-lifestyles.ts --include-inferred.
        if (spec?.inferred) continue;
        let k = 0;
        const make = (p: string) => `${p}_r${id.replace(/\W/g, '').slice(-6)}${(k++).toString(36)}${Date.now().toString(36).slice(-4)}`;
        const added = restoreUpgrades(a, spec, make);
        fillActorRefs(a);
        shop.restored.push(id);
        if (added) {
          history(a, tk('Options restored from Chummer: {n}'), { n: added }, 0);
          n += added;
        }
      }
      if (n) console.log(`[shop] ${n} upgrade(s) restored from the Chummer files`);
    }
  },

  actions: {
    // Buy: { actorId, items: [{ ref: catalogId | 'special:<id>', qty, rating?, grade?, price? (variable-cost items), setMatrix?,
    //        target?: { itemId } (upgrades: weapon / armor / vehicle / lifestyle id), mount? (accessories),
    //        lifestyleName?, primary? (new lifestyle; qty = months paid) }] }
    // Player: own actor only, shop rules apply, may create a pending order. GM: immediate ("Vendre au PJ").
    'shop/buy': {
      role: 'any',
      handler(ctx: ActionContext, { actorId, items }: BuyPayload) {
        const actor = getActor(ctx, actorId);
        if (!Array.isArray(items) || !items.length) return ctx.fail('Empty cart');
        if (items.length > 50) ctx.fail('Cart too full (50 lines max)');
        const shop = ctx.state.shop;
        const lines = resolveLines(ctx, actor, items);
        if (!ctx.isGM) checkRules(ctx, lines);
        checkStock(ctx, lines);
        checkEssence(ctx, actor, lines);
        const testIds = ctx.isGM ? [] : claimAvailTests(ctx, actor, lines);
        const total = lines.reduce((s, l) => s + ((l.unitCost ?? 0) + (l.surcharge || 0)) * l.qty, 0);
        checkFunds(ctx, actor, total);
        const flags = [...new Set(lines.flatMap((l) => lineFlags(shop, l)))];
        // Lifestyle options that lower the rent (negative qualities: Thrifty, Dangerous Area…) always wait for the GM.
        const needsApproval =
          !ctx.isGM &&
          (shop.approval === 'always' || lines.some((l) => l.lowersRent) || (shop.approval === 'restricted' && lines.some((l) => !l.specialId && (l.legality || l.variablePrice))));
        const order: ShopOrder = {
          id: ctx.uid('ord'), ts: ctx.now, actorId: actorId as ActorId, userId: ctx.user.id, by: ctx.isGM ? 'MJ' : ctx.user.name, kind: 'buy',
          items: lines, total, status: needsApproval ? 'pending' : 'done', flags,
        };
        useTests(shop, testIds, order.id);
        if (needsApproval) {
          pushOrder(shop, order);
          shopLog(ctx, actorId as ActorId, tk('{actor} places an order: {items} — {cost} (awaiting the GM)'), { actor: actor.name, items: summary(lines), cost: nuyen(total) });
          ctx.emitTo('gm', 'sfx', { id: 'notify' });
          return { status: 'pending', orderId: order.id, total };
        }
        const notes = applyOrder(ctx, actor, order);
        pushOrder(shop, order);
        return { status: 'done', orderId: order.id, total, notes: notes.map((n) => formatSource(n.key, n.params)), notesI18n: notes };
      },
    },

    // Availability test (SR5 p. 418): { actorId, item: cart line { ref, rating?, grade?, target?, mount?, price? }, useSpec?,
    // explode? (Edge: Push the Limit), modifier?, contactId? }. Negotiation + Charisma [Social] (performRoll: gear, wounds, limit) opposed by
    // Availability dice; the test is stored in shop.availTests and unlocks the purchase of that item (see claimAvailTests).
    // contactId: one of the runner's contacts searches instead (contactStats: their own Charisma + Negotiation, Social limit + Connection).
    'shop/availTest': {
      role: 'any',
      handler(ctx: ActionContext, { actorId, item, useSpec, explode, modifier, contactId, overpay: rawOverpay }: AvailTestPayload) {
        const actor = getActor(ctx, actorId);
        const shop = ctx.state.shop;
        if (!ctx.isGM && shop.availTest === 'off') ctx.fail('No availability tests at this table');
        if (!ctx.isGM && !shop.open) ctx.fail('Cabana can’t be reached right now');
        if (!item || typeof item !== 'object' || Array.isArray(item)) ctx.fail('Missing item');
        const [line] = resolveLines(ctx, actor, [item as CartLine]);
        if (!availTestable({ file: line.file, special: !!line.specialId, availValue: line.availValue })) ctx.fail('{item}: no availability test needed', { item: line.name });
        if (!ctx.isGM) checkRules(ctx, [line]);
        const targetId = line.target?.itemId || '';
        const tries = shop.availTests.filter((x) => x.actorId === actor.id && x.ref === line.ref && (x.targetId || '') === targetId && x.status !== 'used').length + 1;
        const opp = rollDice(line.availValue!);
        const baseHours = availBaseHours(line.unitCost);
        const testId = ctx.uid('av');
        const overpay = clampOverpay(rawOverpay);
        const avail = { testId, value: line.availValue!, legality: line.legality!, dice: opp.dice, hits: opp.hits, baseHours, tries, ...(overpay ? { overpay } : {}) };
        let r: { hits: number; glitch?: boolean; critGlitch?: boolean; logId: string };
        let contact: Contact | null | undefined = null;
        if (contactId) {
          contact = (Array.isArray(actor.contacts) ? actor.contacts : []).find((c: Contact) => c && c.id === String(contactId));
          if (!contact) return ctx.fail('Contact not found');
          r = contactRoll(ctx, actor, contact, line, avail, modifier, overpay);
        } else {
          r = performRoll(
            ctx,
            { actorId: actor.id, skillId: 'negotiation', useSpec: !!useSpec, explode: !!explode, modifier, label: `Availability — ${line.name}` },
            { bonus: overpay ? [{ label: 'overpay', value: overpay }] : [], logExtra: { labelI18n: { key: tk('Availability — {item}'), params: { item: line.name } }, avail } },
          );
        }
        const test: AvailTest = {
          id: testId, ts: ctx.now, actorId: actor.id, userId: ctx.user.id, ref: line.ref, ...(targetId ? { targetId } : {}), name: line.name,
          avail: line.availValue!, legality: line.legality!, availHits: opp.hits, hits: r.hits, glitch: !!r.glitch, critGlitch: !!r.critGlitch, logId: r.logId, baseHours, tries, status: 'open',
          ...(contact ? { contactId: contact.id, contactName: contact.name } : {}), ...(overpay ? { overpay } : {}),
        };
        shop.availTests.push(test);
        if (shop.availTests.length > MAX_AVAIL_TESTS) {
          // Drop the oldest used tests first, then the oldest ones.
          let excess = shop.availTests.length - MAX_AVAIL_TESTS;
          shop.availTests = shop.availTests.filter((x) => !(excess > 0 && x.status === 'used' && excess--));
          if (shop.availTests.length > MAX_AVAIL_TESTS) shop.availTests.splice(0, shop.availTests.length - MAX_AVAIL_TESTS);
        }
        const out = availOutcome(test);
        return { testId, hits: r.hits, availHits: opp.hits, ...out, baseHours, tries, overpay, logId: r.logId };
      },
    },

    // GM gift (no cost, no rules): { actorId, ref, qty?, rating?, grade?, setMatrix?, target?, mount? } or { actorId, items: [...] }
    'shop/give': {
      role: 'gm',
      handler(ctx: ActionContext, { actorId, items, ...single }: GivePayload) {
        const actor = getActor(ctx, actorId);
        const raws = Array.isArray(items) && items.length ? items : [single];
        const lines = resolveLines(ctx, actor, raws);
        checkStock(ctx, lines);
        checkEssence(ctx, actor, lines);
        const order: ShopOrder = { id: ctx.uid('ord'), ts: ctx.now, actorId: actorId as ActorId, userId: ctx.user.id, by: 'MJ', kind: 'give', items: lines, total: 0, status: 'done', flags: [] };
        const notes = applyOrder(ctx, actor, order, { free: true });
        pushOrder(ctx.state.shop, order);
        return { status: 'done', orderId: order.id, notes: notes.map((n) => formatSource(n.key, n.params)), notesI18n: notes };
      },
    },

    // Sell: { actorId, list: 'weapons'|'armor'|'augmentations'|'gear'|'vehicles', itemId, subId? (installed accessory / mod),
    //         qty?, price? (GM: total override) }
    'shop/sell': {
      role: 'any',
      handler(ctx: ActionContext, { actorId, list, itemId, subId, qty, price }: SellPayload) {
        const actor = getActor(ctx, actorId);
        const shop = ctx.state.shop;
        if (!ctx.isGM && !shop.open) ctx.fail('Cabana can’t be reached right now');
        const it = findOwned(ctx, actor, list, itemId);
        let name = it.name;
        let value: number | null;
        let n = 1;
        if (subId) {
          const s = findSub(ctx, it, list as string, subId);
          if (s.included) ctx.fail('Built-in part of {item}: it goes with it', { item: it.name });
          name = s.nameFr || s.name;
          value = subValue(s) || null;
        } else {
          if (list === 'weapons' && it.augId) ctx.fail('Weapon built into an implant: sell the implant itself');
          const have = list === 'gear' ? Math.max(0, int(it.qty ?? 1, 0)) : 1;
          if (have < 1) ctx.fail('No copy left to sell');
          n = list === 'gear' ? clampInt(qty ?? have, 1, have, 1) : 1;
          value = itemValue(list as string, it);
        }
        const key = subId || itemId;
        if (ctx.state.shop.orders.some((o) => o.status === 'pending' && o.kind === 'sell' && (o.items[0]?.subId || o.items[0]?.itemId) === key)) ctx.fail('A resale of this item is already waiting for the GM');
        let total = value === null ? null : Math.round(value * n * (Number(shop.sellRate) || 0) / 100);
        if (ctx.isGM && price !== undefined && price !== null && price !== '') total = Math.max(0, int(price));
        if (ctx.isGM && total === null) ctx.fail('Unknown price: enter a resale amount');
        // unitCost null = unknown value (the GM sets the price).
        const line = { list, itemId, name, qty: n, rating: it.rating ?? null, unitCost: value === null ? null : Math.round(value * (Number(shop.sellRate) || 0) / 100) } as OrderLine;
        if (subId) Object.assign(line, { subId, target: { list, itemId, name: it.name } });
        const order: ShopOrder = {
          id: ctx.uid('ord'), ts: ctx.now, actorId: actorId as ActorId, userId: ctx.user.id, by: ctx.isGM ? 'MJ' : ctx.user.name, kind: 'sell',
          items: [line], total, status: 'pending', flags: total === null ? ['price'] : [],
        };
        if (!ctx.isGM && (shop.approval === 'always' || total === null)) {
          pushOrder(shop, order);
          const item = lineText(line);
          if (total !== null) shopLog(ctx, actorId as ActorId, tk('{actor} offers to sell {item} — {cost} (awaiting the GM)'), { actor: actor.name, item, cost: nuyen(total) });
          else shopLog(ctx, actorId as ActorId, tk('{actor} offers to sell {item} (price to be set) (awaiting the GM)'), { actor: actor.name, item });
          ctx.emitTo('gm', 'sfx', { id: 'notify' });
          return { status: 'pending', orderId: order.id, total };
        }
        order.status = 'done';
        applySell(ctx, actor, order);
        pushOrder(shop, order);
        return { status: 'done', orderId: order.id, total };
      },
    },

    // Remove an upgrade without selling it: { actorId, list: 'weapons'|'armor'|'vehicles'|'lifestyles', itemId, subId }.
    // Players: own actor; lifestyle options that lower the rent (negative qualities) and parts delivered with an item are GM-only.
    'shop/removeUpgrade': {
      role: 'any',
      handler(ctx: ActionContext, { actorId, list, itemId, subId }: RemoveUpgradePayload) {
        const actor = getActor(ctx, actorId);
        const sub = SUB_OF[list as string];
        if (!sub) ctx.fail('Invalid list');
        const it: Loose | undefined = (Array.isArray(actor[list as string]) ? actor[list as string] : []).find((x: Loose) => x && x.id === itemId);
        if (!it) return ctx.fail('Item not found in the inventory');
        const s: Loose | undefined = (Array.isArray(it[sub]) ? it[sub] : []).find((x: Loose) => x && x.id === subId);
        if (!s) return ctx.fail('Option not found');
        if (!ctx.isGM) {
          if (list === 'lifestyles' && (s.category === 'Negative' || Number(s.multiplier) < 0 || Number(s.cost) < 0)) ctx.fail('Only the GM can remove this option');
          if (s.included) ctx.fail('Only the GM can remove this option');
        }
        it[sub] = it[sub].filter((x: Loose) => x.id !== subId);
        if (list === 'lifestyles') settleLifestyles(actor);
        const params = { actor: actor.name, item: s.nameFr || s.name, target: it.name };
        history(actor, tk('Option removed: {item} ({target})'), params, 0);
        shopLog(ctx, actor.id, tk('{actor} removes {item} from {target}'), params);
        return { ok: true, monthlyCost: list === 'lifestyles' ? it.monthlyCost : undefined };
      },
    },

    // GM: approve or deny a pending order. { orderId, approve: bool, note?, total? (override, e.g. negotiated price) }
    'shop/resolve': {
      role: 'gm',
      handler(ctx: ActionContext, { orderId, approve, note, total }: ResolvePayload) {
        const shop = ctx.state.shop;
        const order = shop.orders.find((o) => o.id === orderId);
        if (!order) return ctx.fail('Order not found');
        if (order.status !== 'pending') ctx.fail('This order has already been handled');
        const actor = ctx.state.actors?.[order.actorId] as ShopActor | undefined;
        if (note !== undefined) order.gmNote = str(note, 500) || undefined;
        if (!approve) {
          order.status = 'denied';
          order.resolvedTs = ctx.now;
          releaseTests(shop, order.id); // the item was found: the runner keeps the search for another try
          if (actor) {
            const p = { actor: actor.name, items: summary(order.items), note: order.gmNote || '' };
            if (order.kind === 'sell') {
              if (order.gmNote) shopLog(ctx, actor.id, tk('Order denied for {actor}: resale of {items} — « {note} »'), p);
              else shopLog(ctx, actor.id, tk('Order denied for {actor}: resale of {items}'), p);
            } else if (order.gmNote) shopLog(ctx, actor.id, tk('Order denied for {actor}: {items} — « {note} »'), p);
            else shopLog(ctx, actor.id, tk('Order denied for {actor}: {items}'), p);
          }
          notifyOwners(ctx, order.actorId, 'shop:resolved', { orderId: order.id, status: 'denied', note: order.gmNote || '' });
          return { status: 'denied' };
        }
        if (!actor) return ctx.fail('The character of this order no longer exists');
        if (total !== undefined && total !== null && total !== '' && order.kind !== 'karma') order.total = Math.max(0, int(total));
        if (order.kind === 'sell') {
          if (order.total === null || order.total === undefined) ctx.fail('Enter the resale amount');
          applySell(ctx, actor, order);
        } else if (order.kind === 'karma') {
          const l = order.items[0];
          applyMartial(ctx, actor, martialPlan(ctx, actor, l.ref, l.techniqueIds), { free: false });
        } else {
          checkStock(ctx, order.items);
          checkEssence(ctx, actor, order.items);
          checkFunds(ctx, actor, order.total!);
          applyOrder(ctx, actor, order);
        }
        order.status = 'approved';
        order.resolvedTs = ctx.now;
        notifyOwners(ctx, order.actorId, 'shop:resolved', { orderId: order.id, status: 'approved', note: order.gmNote || '' });
        return { status: 'approved' };
      },
    },

    // Owner (or GM) cancels a pending order: { orderId }
    'shop/cancel': {
      role: 'any',
      handler(ctx: ActionContext, { orderId }: OrderPayload) {
        const order = ctx.state.shop.orders.find((o) => o.id === orderId);
        if (!order) return ctx.fail('Order not found');
        if (!ctx.isGM && order.userId !== ctx.user.id && !ctx.owns(order.actorId)) ctx.fail('That is not your order');
        if (order.status !== 'pending') ctx.fail('This order is no longer pending');
        order.status = 'cancelled';
        order.resolvedTs = ctx.now;
        releaseTests(ctx.state.shop, order.id);
        return { status: 'cancelled' };
      },
    },

    // Martial arts (karma): { actorId, styleId, techniqueIds: [], free? (GM: no karma) }.
    // Player → pending order (kind 'karma', the GM approves and the karma is spent then). GM → granted at once.
    'shop/martialArt': {
      role: 'any',
      handler(ctx: ActionContext, { actorId, styleId, techniqueIds, free }: MartialArtPayload) {
        const actor = getActor(ctx, actorId);
        const plan = martialPlan(ctx, actor, styleId, techniqueIds);
        if (ctx.isGM) {
          const m = applyMartial(ctx, actor, plan, { free: !!free });
          return { status: 'done', martialArtId: m.id, karma: free ? 0 : plan.karma };
        }
        if ((Number(actor.karma) || 0) < plan.karma) ctx.fail('Not enough karma: {cost} needed, {have} available', { cost: plan.karma, have: Number(actor.karma) || 0 });
        if (ctx.state.shop.orders.some((o) => o.status === 'pending' && o.kind === 'karma' && o.actorId === actorId && o.items[0]?.ref === plan.style.id)) ctx.fail('A request for this martial art is already waiting for the GM');
        const names = plan.techniques.map((t) => t.nameFr || t.name);
        const line: OrderLine = { ref: plan.style.id, file: 'martialarts', name: itemName(plan.style), qty: 1, unitCost: 0, karma: plan.karma, techniqueIds: plan.techniques.map((t) => t.id), techniques: names };
        const order: ShopOrder = { id: ctx.uid('ord'), ts: ctx.now, actorId: actorId as ActorId, userId: ctx.user.id, by: ctx.user.name, kind: 'karma', items: [line], total: 0, karma: plan.karma, status: 'pending', flags: [] };
        pushOrder(ctx.state.shop, order);
        shopLog(ctx, actorId as ActorId, tk('{actor} asks to learn {style} ({techniques}) — {karma} karma (waiting for the GM)'), { actor: actor.name, style: line.name, techniques: names.join(', ') || '—', karma: plan.karma });
        ctx.emitTo('gm', 'sfx', { id: 'notify' });
        return { status: 'pending', orderId: order.id, karma: plan.karma };
      },
    },

    // GM: { open?, markup?, sellRate?, maxAvail?, allowRestricted?, allowForbidden?, approval?, availTest?, availFree?, categories?: { file: bool } }
    'shop/updateSettings': {
      role: 'gm',
      handler(ctx: ActionContext, p: SettingsPayload) {
        const shop = ctx.state.shop;
        if (p.open !== undefined) shop.open = !!p.open;
        if (p.markup !== undefined) shop.markup = clampInt(p.markup, -90, 500, 0);
        if (p.sellRate !== undefined) shop.sellRate = clampInt(p.sellRate, 0, 100, 50);
        if (p.maxAvail !== undefined) shop.maxAvail = clampInt(p.maxAvail, 0, 40, 12);
        if (p.allowRestricted !== undefined) shop.allowRestricted = !!p.allowRestricted;
        if (p.allowForbidden !== undefined) shop.allowForbidden = !!p.allowForbidden;
        if (p.approval !== undefined) {
          if (!APPROVAL_MODES.includes(p.approval)) ctx.fail('Unknown approval mode');
          shop.approval = p.approval as ShopState['approval'];
        }
        if (p.availTest !== undefined) {
          if (!AVAIL_TEST_MODES.includes(p.availTest)) ctx.fail('Unknown availability test mode');
          shop.availTest = p.availTest as ShopState['availTest'];
        }
        if (p.availFree !== undefined) shop.availFree = clampInt(p.availFree, 0, 40, 0);
        if (p.categories && typeof p.categories === 'object') {
          for (const [k, v] of Object.entries(p.categories)) if (SHOP_FILES.includes(k as CatalogFile)) shop.categories[k as CatalogFile] = !!v;
        }
        return { ok: true };
      },
    },

    // GM: { special: {...fields} } or { fromRef: catalogId, rating?, grade?, cost?, stock?, notes? }. Returns { id }.
    'shop/addSpecial': {
      role: 'gm',
      handler(ctx: ActionContext, { special, fromRef, ...rest }: AddSpecialPayload) {
        let src: Loose = special && typeof special === 'object' ? { ...special } : {};
        if (fromRef) {
          const entry = INDEX.get(fromRef);
          if (!entry) return ctx.fail('Item not in the catalog');
          if (isUpgradeFile(entry.file) || entry.file === 'lifestyles') ctx.fail('This item cannot become a deal');
          const q = quote(entry.item, { rating: rest.rating, grade: rest.grade });
          src = {
            name: itemName(entry.item) + (q.rating ? ` (ind. ${q.rating})` : ''),
            category: entry.item.categoryFr || entry.item.category,
            file: entry.file,
            cost: q.unitCost,
            originalCost: q.unitCost,
            avail: q.avail,
            stock: 1,
            notes: '',
            rating: q.rating,
            grade: q.grade || undefined,
            essence: q.essence,
            catalogRef: entry.item.id,
            ...rest,
            ...src,
          };
          delete src.fromRef;
        }
        if (!src.name) src.name = ctx.t(tk('New deal')); // stored in the table language
        const sp = sanitizeSpecial(ctx, src, { id: ctx.uid('spc') });
        ctx.state.shop.specials.push(sp);
        return { id: sp.id };
      },
    },

    // GM: { id, patch: {...fields} }
    'shop/updateSpecial': {
      role: 'gm',
      handler(ctx: ActionContext, { id, patch }: UpdateSpecialPayload) {
        const shop = ctx.state.shop;
        const i = shop.specials.findIndex((s) => s.id === id);
        if (i < 0) ctx.fail('Deal not found');
        shop.specials[i] = sanitizeSpecial(ctx, patch || {}, shop.specials[i]);
        return { ok: true };
      },
    },

    // GM: { id }
    'shop/removeSpecial': {
      role: 'gm',
      handler(ctx: ActionContext, { id }: IdPayload) {
        const shop = ctx.state.shop;
        if (!shop.specials.some((s) => s.id === id)) ctx.fail('Deal not found');
        shop.specials = shop.specials.filter((s) => s.id !== id);
        if (!shop.removedSeedIds!.includes(id as string)) shop.removedSeedIds!.push(id as string);
        return { ok: true };
      },
    },

    // Pay rent in advance: { actorId, lifestyleId? (default: primary), months } — uses the lifestyle's monthly cost (upgrades included).
    'shop/payLifestyle': {
      role: 'any',
      handler(ctx: ActionContext, { actorId, lifestyleId, months }: PayLifestylePayload) {
        const actor = getActor(ctx, actorId);
        if (Array.isArray(actor.lifestyles)) settleLifestyles(actor);
        let lf: Loose | null | undefined;
        if (lifestyleId) {
          lf = (actor.lifestyles || []).find((l: Loose) => l.id === lifestyleId);
          if (!lf) return ctx.fail('Lifestyle not found');
        } else lf = primaryLifestyle(actor);
        if (!lf || !(Number(lf.monthlyCost) > 0)) return ctx.fail('No lifestyle set for this character');
        const m = int(months, 1);
        if (m < 1 || m > 24) ctx.fail('Invalid number of months (1 to 24)');
        const total = Math.round(Number(lf.monthlyCost) * m);
        checkFunds(ctx, actor, total);
        actor.nuyen = (Number(actor.nuyen) || 0) - total;
        lf.monthsPaid = (Number(lf.monthsPaid) || 0) + m;
        history(actor, tk('Rent: {name} — {n} month(s)'), { name: lf.name, n: m }, -total);
        shopLog(ctx, actorId as ActorId, tk('{actor} pays {n} month(s) of lifestyle ({name}) — {cost}'), { actor: actor.name, n: m, name: lf.name, cost: nuyen(total) });
        notifyOwners(ctx, actorId as ActorId, 'sfx', { id: 'cash' });
        return { monthsPaid: lf.monthsPaid, total, lifestyleId: lf.id };
      },
    },

    // Home of a lifestyle (shared/home.js): the first pick is free; another layout on the same level is a move,
    // paid one month of the level's rent by the player (house rule — the GM moves runners for free).
    // { actorId, lifestyleId, layout?, x?, y? } — see moveHome().
    'shop/move': {
      role: 'any',
      handler: (ctx: ActionContext, payload: MovePayload) => moveHome(ctx, payload),
    },
    // Level-1 name (flat only), kept for older clients.
    'shop/chooseHome': {
      role: 'any',
      handler: (ctx: ActionContext, { actorId, lifestyleId, layout }: MovePayload) => moveHome(ctx, { actorId, lifestyleId, layout: typeof layout === 'string' && layout ? layout : '?' }),
    },

    // GM: remove resolved orders from the history (pending ones are kept).
    'shop/clearOrders': {
      role: 'gm',
      handler(ctx: ActionContext) {
        ctx.state.shop.orders = ctx.state.shop.orders.filter((o) => o.status === 'pending');
        return { ok: true };
      },
    },
  },

  filter(view, user, fullState) {
    if (!view.shop) return;
    const mine = new Set(user.characterIds || []);
    view.shop.orders = (view.shop.orders || []).filter((o) => o.userId === user.id || mine.has(o.actorId));
    view.shop.availTests = (view.shop.availTests || []).filter((x) => mine.has(x.actorId));
    // Who can search for each of the player's runners (bestiary / NPC stats are not in a player's view).
    view.shop.contactSearch = {};
    for (const id of mine) {
      const a = fullState.actors?.[id];
      if (a) view.shop.contactSearch[id] = (Array.isArray(a.contacts) ? a.contacts : []).filter((c) => c?.id && c.name).map((c) => contactInfo(fullState, c));
    }
    view.shop.specials = (view.shop.specials || [])
      .filter((s) => !s.hidden && (!s.forActorIds?.length || s.forActorIds.some((id) => mine.has(id))))
      .map(({ gmNotes, ...s }) => s);
    delete view.shop.removedSeedIds;
    delete view.shop.restored;
  },
};

export default mod;
