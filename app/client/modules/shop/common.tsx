// Shop client helpers: catalog loading/indexing, cart store, pricing/eligibility, small shared widgets.
import { useEffect, useMemo, useState } from 'react';
import { Badge, type BadgeColor } from '../../lib/ui.tsx';
import { loadCatalog } from '../../lib/net.ts';
import { t, tk, fmtNuyen, fmtDate, itemName, getLang, compare } from '../../lib/i18n.ts';
import { SHOP_FILES, STORE_SECTIONS, quote, parseAvailString, fold, GRADES, lowersRent } from './rules.ts';
import type { Actor, CatalogFile, CatalogItem, GameView, ShopSpecial, ShopState, Timestamp } from '../../../shared/types.ts';
import type { BuyStatus, CartLine, OwnedItem, PriceQuote, ShopCatalog, ShopEntry, ShopItem } from './types.ts';

/** Nuyen amount in the UI language ('12 500¥' / '12,500¥'). */
export const nuyen: (n: unknown) => string = fmtNuyen;

const UPGRADE_FILE_SET = new Set(['accessories', 'armormods', 'vehiclemods', 'lifestylequalities', 'lifestyles']);

/** Catalog category in the UI language. */
const categoryOf = (item: ShopItem): string => (getLang() === 'fr' ? item.categoryFr || item.category : item.category || item.categoryFr || '');

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------
let catalogCache: ShopCatalog | null = null;
let catalogPromise: Promise<ShopCatalog> | null = null;

interface CatalogPart {
  file: CatalogFile;
  list: ShopItem[];
  error: boolean;
}

function buildCatalog(parts: CatalogPart[]): ShopCatalog {
  const entries: ShopEntry[] = [];
  const byId = new Map<string, ShopEntry>();
  for (const { file, list } of parts) {
    for (const item of list || []) {
      const section: string = STORE_SECTIONS.find((s: { match: (f: string, i: ShopItem) => boolean }) => s.match(file, item))?.id || 'gear';
      // name / category are getters: the catalog is cached across language switches.
      const e: ShopEntry = {
        ref: item.id,
        file,
        item,
        section,
        get name() {
          return itemName(item);
        },
        get category() {
          return categoryOf(item);
        },
        search: fold(`${item.name} ${item.nameFr || ''} ${item.category} ${item.categoryFr || ''}`),
      };
      entries.push(e);
      byId.set(item.id, e);
    }
  }
  return { entries, byId, error: parts.some((p) => p.error) };
}

/** Hook: { entries, byId, error } once every shop catalog file is loaded (null while loading). */
export function useShopCatalog(): ShopCatalog | null {
  const [data, setData] = useState(catalogCache);
  useEffect(() => {
    if (catalogCache) return;
    let alive = true;
    if (!catalogPromise) {
      catalogPromise = Promise.all(
        (SHOP_FILES as CatalogFile[]).map((file) =>
          loadCatalog<ShopItem>(file)
            .then((list) => ({ file, list: Array.isArray(list) ? list : [], error: !Array.isArray(list) || !list.length }))
            .catch(() => ({ file, list: [], error: true }))
        )
      ).then((parts) => (catalogCache = buildCatalog(parts)));
    }
    catalogPromise.then((c) => alive && setData(c));
    return () => {
      alive = false;
    };
  }, []);
  return data;
}

let martialCache: CatalogItem[] | null = null;
let martialPromise: Promise<CatalogItem[]> | null = null;
/** Hook: martial art styles (data/catalog/martialarts.json — karma, not sold for nuyen), null while loading. */
export function useMartialCatalog<T = CatalogItem>(): T[] | null {
  const [data, setData] = useState(martialCache);
  useEffect(() => {
    if (martialCache) return;
    let alive = true;
    if (!martialPromise)
      martialPromise = loadCatalog<CatalogItem>('martialarts')
        .then((l) => (martialCache = Array.isArray(l) ? l : []))
        .catch(() => (martialCache = []));
    martialPromise.then((c) => alive && setData(c));
    return () => {
      alive = false;
    };
  }, []);
  return data as T[] | null;
}

/** Turn a fixer special into a storefront entry (stats borrowed from its catalog item if any). */
export function specialEntry(sp: ShopSpecial, catalog: ShopCatalog | null): ShopEntry {
  const base = sp.catalogRef ? catalog?.byId.get(sp.catalogRef) : null;
  return {
    ref: `special:${sp.id}`,
    file: sp.file || base?.file || 'gear',
    item: base?.item || null,
    special: sp,
    section: 'specials',
    name: sp.name,
    category: sp.category || base?.category || t('Deal'),
    search: fold(`${sp.name} ${sp.category || ''} ${base?.item?.name || ''}`),
  };
}

/** Options of a price quote (rules.js quote). */
export interface PriceOpts {
  rating?: number | null;
  grade?: string | null;
  price?: number | null;
}

/** Price sheet for an entry: { unitCost, availValue, legality, avail, rating, grade, essence }. */
export function priceEntry(entry: ShopEntry, opts: PriceOpts, shop: Partial<ShopState> | null | undefined): PriceQuote {
  if (entry.special) {
    const sp = entry.special;
    const av = parseAvailString(sp.avail);
    const ware = entry.file === 'cyberware' || entry.file === 'bioware';
    let essence: number | undefined;
    if (ware) {
      // essence may come as a string from the specials editor (TextInput)
      const spEss = sp.essence;
      if (spEss !== undefined && spEss !== null && spEss !== '') essence = Number(spEss) || 0;
      else if (entry.item) essence = safeQuote(entry.item, { rating: sp.rating, grade: sp.grade }).essence ?? 0;
      else essence = 0;
    }
    return { unitCost: Number(sp.cost) || 0, availValue: av.value, legality: av.legality, avail: `${av.value}${av.legality}`, rating: sp.rating ?? null, grade: ware ? sp.grade || 'standard' : null, essence };
  }
  return safeQuote(entry.item as ShopItem, { ...opts, markup: entry.file === 'lifestyles' ? 0 : shop?.markup || 0 });
}

function safeQuote(item: ShopItem, opts: PriceOpts & { markup?: number }): PriceQuote {
  try {
    return quote(item, opts);
  } catch {
    return { unitCost: Number(item.cost) || 0, availValue: Number(item.availValue) || 0, legality: item.legality || '', avail: item.avail || '0', rating: null, grade: null };
  }
}

/**
 * Can this user buy it? → { ok, reason?, approval: bool } — reason is already translated.
 * Mirrors the server rules (server/modules/40-shop.js checkRules) — the server stays the authority.
 */
export function buyStatus(shop: Partial<ShopState> | null | undefined, entry: ShopEntry, q: PriceQuote, isGM: boolean): BuyStatus {
  if (isGM) return { ok: true, approval: false };
  if (!shop?.open) return { ok: false, reason: t('Shop closed'), approval: false, closed: true };
  if (entry.special) {
    if (entry.special.stock !== null && entry.special.stock !== undefined && entry.special.stock <= 0) return { ok: false, reason: t('Sold out'), approval: false };
    return { ok: true, approval: shop.approval === 'always' };
  }
  if (shop.categories?.[entry.file] === false) return { ok: false, reason: t('Section closed'), approval: false };
  if (q.availValue > (shop.maxAvail as number)) return { ok: false, reason: t('Avail {avail} > {max}', { avail: q.availValue, max: shop.maxAvail }), approval: false };
  if (q.legality === 'F' && !shop.allowForbidden) return { ok: false, reason: t('Forbidden'), approval: false };
  if (q.legality === 'R' && !shop.allowRestricted) return { ok: false, reason: t('Restricted'), approval: false };
  // Lifestyle options that lower the rent always wait for the GM (server: 40-shop needsApproval).
  const approval =
    shop.approval === 'always' || (entry.file === 'lifestylequalities' && lowersRent(entry.item)) || (shop.approval === 'restricted' && (!!q.legality || !!entry.item?.costRange));
  return { ok: true, approval };
}

// ---------------------------------------------------------------------------
// Cart store (per actor, kept in localStorage so it survives tab switches and reloads)
// ---------------------------------------------------------------------------
const CART_KEY = 'sr.shop.cart';
let carts: Record<string, CartLine[]> = {};
try {
  carts = JSON.parse(localStorage.getItem(CART_KEY) || '{}') || {};
} catch {
  carts = {};
}
const cartListeners = new Set<() => void>();
function saveCarts() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(carts));
  } catch {}
  for (const l of cartListeners) l();
}

export const lineKey = (l: CartLine): string =>
  [l.ref, l.rating ?? '', l.grade ?? '', l.price ?? '', l.setMatrix ? 1 : '', l.target?.itemId ?? '', l.mount ?? '', l.lifestyleName ?? ''].join('|');

export function getCart(actorId: string | null | undefined): CartLine[] {
  return (actorId && carts[actorId]) || [];
}
export function setCart(actorId: string | null | undefined, lines: CartLine[]) {
  if (!actorId) return;
  carts = { ...carts, [actorId]: lines };
  if (!lines.length) delete carts[actorId];
  saveCarts();
}
export function addToCart(actorId: string, line: CartLine) {
  const lines = getCart(actorId).slice();
  const k = lineKey(line);
  const i = lines.findIndex((l) => lineKey(l) === k);
  if (i >= 0) lines[i] = { ...lines[i], qty: Math.min(999, lines[i].qty + line.qty) };
  else lines.push(line);
  setCart(actorId, lines);
}
/** Hook: current cart lines of an actor. */
export function useCart(actorId: string | null | undefined): CartLine[] {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    cartListeners.add(l);
    return () => {
      cartListeners.delete(l);
    };
  }, []);
  return getCart(actorId);
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
/** Hook: true while the media query matches. */
export function useMedia(query: string): boolean {
  const get = () => (typeof matchMedia === 'function' ? matchMedia(query).matches : false);
  const [m, setM] = useState(get);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(query);
    const h = () => setM(mq.matches);
    h();
    if (mq.addEventListener) mq.addEventListener('change', h);
    else mq.addListener(h);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', h);
      else mq.removeListener(h);
    };
  }, [query]);
  return m;
}

interface AvailBadgeProps {
  avail: string;
  value: number;
  legality: string;
  max?: number;
}
/** Availability pill: green legal, amber R, red F; dimmed + striked when above the limit. */
export function AvailBadge({ avail, value, legality, max }: AvailBadgeProps) {
  const over = max !== undefined && value > max;
  const color = legality === 'F' ? 'red' : legality === 'R' ? 'amber' : 'green';
  const legal = legality === 'F' ? t('Forbidden') : legality === 'R' ? t('Restricted') : t('Legal');
  const title = over ? t('{legal} — availability {value} (above the limit {max})', { legal, value, max }) : t('{legal} — availability {value}', { legal, value });
  return (
    <span className={'shop-avail' + (over ? ' over' : '')}>
      <Badge color={color} title={title}>
        {avail}
      </Badge>
    </span>
  );
}

/** 'alpha' → « Alphaware » (translated). */
export function gradeLabel(g: string | null | undefined): string {
  const grades = GRADES as Record<string, { label: string }>;
  return g && grades[g] ? t(grades[g].label) : g || '';
}

// Constant tables hold English UI keys (tk): render with t(STATUS_LABEL[s]) / t(FLAG_LABEL[f]).
export const STATUS_LABEL: Record<string, string> = { pending: tk('Pending'), approved: tk('fem::Approved'), denied: tk('Denied'), done: tk('status::Done'), cancelled: tk('Cancelled') };
export const STATUS_COLOR: Record<string, BadgeColor> = { pending: 'amber', approved: 'green', denied: 'red', done: 'cyan', cancelled: 'dim' };
export const FLAG_LABEL: Record<string, string> = { restricted: tk('Restricted'), forbidden: tk('Forbidden'), avail: tk('Avail > limit'), price: tk('Price to be set') };
export const FLAG_COLOR: Record<string, BadgeColor> = { restricted: 'amber', forbidden: 'red', avail: 'magenta', price: 'cyan' };

export function timeAgo(ts: Timestamp): string {
  const d = Date.now() - ts;
  if (d < 60e3) return t('just now');
  if (d < 3600e3) return t('{n} min ago', { n: Math.floor(d / 60e3) });
  if (d < 86400e3) return t('{n} h ago', { n: Math.floor(d / 3600e3) });
  return (fmtDate as (ts: number, opts?: Intl.DateTimeFormatOptions) => string)(ts, { day: 'numeric', month: 'short' });
}

/** PCs the current user can shop for (player: own characters; GM: every active PC). */
export function useShopActors(game: GameView): Actor[] {
  return useMemo(() => {
    // Full sheets only: players get other NPCs as stubs, never their own characters.
    const full = (a: GameView['actors'][string] | undefined): a is Actor => !!a && 'attributes' in a;
    const actors = Object.values(game.actors || {}).filter(full);
    if (game.me.role === 'gm') return actors.filter((a) => a.type === 'pc' && !a.retired).sort((a, b) => compare(a.name, b.name));
    return (game.me.characterIds || []).map((id) => game.actors?.[id]).filter(full);
  }, [game.actors, game.me]);
}

const SUBS: Record<string, string> = { weapons: 'accessories', armor: 'mods', vehicles: 'mods' };

/** Something with a resale value: paid price, catalog cost, or delivered with its parent item. */
interface Valued {
  paid?: number | string | null;
  cost?: number | null;
  included?: boolean;
}
/** Value (100%) of an installed accessory / mod (0 for parts delivered with the item). Mirrors server subValue(). */
export function subValue(s: Valued | OwnedItem | null | undefined): number {
  if (!s || s.included) return 0;
  if (s.paid !== undefined && s.paid !== null && s.paid !== '' && Number.isFinite(Number(s.paid))) return Number(s.paid);
  return Math.max(0, Number(s.cost) || 0);
}

/** Estimated full value (100%) of an owned item (installed accessories/mods included), for resale previews. Mirrors server itemValue(). */
export function ownedValue(list: string, it: OwnedItem, catalog: ShopCatalog | null): number | null {
  const subs = SUBS[list] && Array.isArray(it[SUBS[list]]) ? (it[SUBS[list]] as Valued[]).reduce((s, x) => s + subValue(x), 0) : 0;
  const own = ownedBaseValue(list, it, catalog);
  return own === null ? (subs ? subs : null) : own + subs;
}

function ownedBaseValue(list: string, it: OwnedItem, catalog: ShopCatalog | null): number | null {
  if (it.paid !== undefined && it.paid !== null && it.paid !== '' && Number.isFinite(Number(it.paid))) return Number(it.paid);
  if (!catalog) return null;
  let e = it.catalogId ? catalog.byId.get(it.catalogId) : null;
  if (!e) {
    const k = fold(it.name);
    if (!k) return null;
    e = catalog.entries.find((x) => !UPGRADE_FILE_SET.has(x.file) && (fold(x.item?.name) === k || fold(x.item?.nameFr) === k)) || null;
  }
  if (!e || !e.item) return null;
  const q = safeQuote(e.item, { rating: it.rating, grade: it.grade });
  const per = list === 'gear' ? Number(e.item.stats?.costFor) || 1 : 1;
  return Math.round((q.unitCost / per) * 100) / 100;
}
