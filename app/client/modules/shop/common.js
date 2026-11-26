// Shop client helpers: catalog loading/indexing, cart store, pricing/eligibility, small shared widgets.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { html, Badge } from '../../lib/ui.js';
import { loadCatalog } from '../../lib/net.js';
import { t, tk, fmtNuyen, fmtDate, itemName, getLang, compare } from '../../lib/i18n.js';
import { SHOP_FILES, SECTIONS, quote, parseAvailString, fold, GRADES } from './rules.js';

/** Nuyen amount in the UI language ('12 500¥' / '12,500¥'). */
export const nuyen = fmtNuyen;

/** Catalog category in the UI language. */
const categoryOf = (item) => (getLang() === 'fr' ? item.categoryFr || item.category : item.category || item.categoryFr);

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------
let catalogCache = null;
let catalogPromise = null;

function buildCatalog(parts) {
  const entries = [];
  const byId = new Map();
  for (const { file, list } of parts) {
    for (const item of list || []) {
      const section = SECTIONS.find((s) => s.match(file, item))?.id || 'gear';
      // name / category are getters: the catalog is cached across language switches.
      const e = {
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
export function useShopCatalog() {
  const [data, setData] = useState(catalogCache);
  useEffect(() => {
    if (catalogCache) return;
    let alive = true;
    if (!catalogPromise) {
      catalogPromise = Promise.all(
        SHOP_FILES.map((file) =>
          loadCatalog(file)
            .then((list) => ({ file, list: Array.isArray(list) ? list : [], error: !Array.isArray(list) || !list.length }))
            .catch(() => ({ file, list: [], error: true }))
        )
      ).then((parts) => (catalogCache = buildCatalog(parts)));
    }
    catalogPromise.then((c) => alive && setData(c));
    return () => (alive = false);
  }, []);
  return data;
}

/** Turn a fixer special into a storefront entry (stats borrowed from its catalog item if any). */
export function specialEntry(sp, catalog) {
  const base = sp.catalogRef ? catalog?.byId.get(sp.catalogRef) : null;
  return {
    ref: `special:${sp.id}`,
    file: sp.file || base?.file || 'gear',
    item: base?.item || null,
    special: sp,
    section: 'specials',
    name: sp.name,
    category: sp.category || base?.category || t('Offre'),
    search: fold(`${sp.name} ${sp.category || ''} ${base?.item?.name || ''}`),
  };
}

/** Price sheet for an entry: { unitCost, availValue, legality, avail, rating, grade, essence }. */
export function priceEntry(entry, opts, shop) {
  if (entry.special) {
    const sp = entry.special;
    const av = parseAvailString(sp.avail);
    const ware = entry.file === 'cyberware' || entry.file === 'bioware';
    let essence;
    if (ware) {
      if (sp.essence !== undefined && sp.essence !== null && sp.essence !== '') essence = Number(sp.essence) || 0;
      else if (entry.item) essence = safeQuote(entry.item, { rating: sp.rating, grade: sp.grade }).essence ?? 0;
      else essence = 0;
    }
    return { unitCost: Number(sp.cost) || 0, availValue: av.value, legality: av.legality, avail: `${av.value}${av.legality}`, rating: sp.rating ?? null, grade: ware ? sp.grade || 'standard' : null, essence };
  }
  return safeQuote(entry.item, { ...opts, markup: entry.file === 'lifestyles' ? 0 : shop?.markup || 0 });
}

function safeQuote(item, opts) {
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
export function buyStatus(shop, entry, q, isGM) {
  if (isGM) return { ok: true, approval: false };
  if (!shop?.open) return { ok: false, reason: t('Boutique fermée'), approval: false, closed: true };
  if (entry.special) {
    if (entry.special.stock !== null && entry.special.stock !== undefined && entry.special.stock <= 0) return { ok: false, reason: t('Épuisé'), approval: false };
    return { ok: true, approval: shop.approval === 'always' };
  }
  if (shop.categories?.[entry.file] === false) return { ok: false, reason: t('Rayon fermé'), approval: false };
  if (q.availValue > shop.maxAvail) return { ok: false, reason: t('Dispo {avail} > {max}', { avail: q.availValue, max: shop.maxAvail }), approval: false };
  if (q.legality === 'F' && !shop.allowForbidden) return { ok: false, reason: t('Interdit'), approval: false };
  if (q.legality === 'R' && !shop.allowRestricted) return { ok: false, reason: t('Restreint'), approval: false };
  const approval = shop.approval === 'always' || (shop.approval === 'restricted' && (!!q.legality || !!entry.item?.costRange));
  return { ok: true, approval };
}

// ---------------------------------------------------------------------------
// Cart store (per actor, kept in localStorage so it survives tab switches and reloads)
// ---------------------------------------------------------------------------
const CART_KEY = 'sr.shop.cart';
let carts = {};
try {
  carts = JSON.parse(localStorage.getItem(CART_KEY) || '{}') || {};
} catch {
  carts = {};
}
const cartListeners = new Set();
function saveCarts() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(carts));
  } catch {}
  for (const l of cartListeners) l();
}

export const lineKey = (l) => [l.ref, l.rating ?? '', l.grade ?? '', l.price ?? '', l.setMatrix ? 1 : ''].join('|');

export function getCart(actorId) {
  return (actorId && carts[actorId]) || [];
}
export function setCart(actorId, lines) {
  if (!actorId) return;
  carts = { ...carts, [actorId]: lines };
  if (!lines.length) delete carts[actorId];
  saveCarts();
}
export function addToCart(actorId, line) {
  const lines = getCart(actorId).slice();
  const k = lineKey(line);
  const i = lines.findIndex((l) => lineKey(l) === k);
  if (i >= 0) lines[i] = { ...lines[i], qty: Math.min(999, lines[i].qty + line.qty) };
  else lines.push(line);
  setCart(actorId, lines);
}
/** Hook: current cart lines of an actor. */
export function useCart(actorId) {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    cartListeners.add(l);
    return () => cartListeners.delete(l);
  }, []);
  return getCart(actorId);
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------
/** Hook: true while the media query matches. */
export function useMedia(query) {
  const get = () => (typeof matchMedia === 'function' ? matchMedia(query).matches : false);
  const [m, setM] = useState(get);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(query);
    const h = () => setM(mq.matches);
    h();
    mq.addEventListener ? mq.addEventListener('change', h) : mq.addListener(h);
    return () => (mq.removeEventListener ? mq.removeEventListener('change', h) : mq.removeListener(h));
  }, [query]);
  return m;
}

/** Availability pill: green legal, amber R, red F; dimmed + striked when above the limit. */
export function AvailBadge({ avail, value, legality, max }) {
  const over = max !== undefined && value > max;
  const color = legality === 'F' ? 'red' : legality === 'R' ? 'amber' : 'green';
  const legal = legality === 'F' ? t('Interdit') : legality === 'R' ? t('Restreint') : t('Légal');
  const title = over ? t('{legal} — disponibilité {value} (au-dessus de la limite {max})', { legal, value, max }) : t('{legal} — disponibilité {value}', { legal, value });
  return html`<span class=${'shop-avail' + (over ? ' over' : '')}><${Badge} color=${color} title=${title}>${avail}</${Badge}></span>`;
}

/** 'alpha' → « Alphaware » (translated). */
export function gradeLabel(g) {
  return GRADES[g] ? t(GRADES[g].label) : g || '';
}

// Constant tables hold French keys (tk): render with t(STATUS_LABEL[s]) / t(FLAG_LABEL[f]).
export const STATUS_LABEL = { pending: tk('En attente'), approved: tk('Validée'), denied: tk('Refusée'), done: tk('Effectuée'), cancelled: tk('Annulée') };
export const STATUS_COLOR = { pending: 'amber', approved: 'green', denied: 'red', done: 'cyan', cancelled: 'dim' };
export const FLAG_LABEL = { restricted: tk('Restreint'), forbidden: tk('Interdit'), avail: tk('Dispo > limite'), price: tk('Prix à fixer') };
export const FLAG_COLOR = { restricted: 'amber', forbidden: 'red', avail: 'magenta', price: 'cyan' };

export function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60e3) return t('à l’instant');
  if (d < 3600e3) return t('il y a {n} min', { n: Math.floor(d / 60e3) });
  if (d < 86400e3) return t('il y a {n} h', { n: Math.floor(d / 3600e3) });
  return fmtDate(ts, { day: 'numeric', month: 'short' });
}

/** PCs the current user can shop for (player: own characters; GM: every active PC). */
export function useShopActors(game) {
  return useMemo(() => {
    const actors = Object.values(game.actors || {});
    if (game.me.role === 'gm') return actors.filter((a) => a.type === 'pc' && !a.retired).sort((a, b) => compare(a.name, b.name));
    return (game.me.characterIds || []).map((id) => game.actors?.[id]).filter(Boolean);
  }, [game.actors, game.me]);
}

/** Estimated full value (100%) of an owned item, for resale previews. Mirrors server itemValue(). */
export function ownedValue(list, it, catalog) {
  if (it.paid !== undefined && it.paid !== null && it.paid !== '' && Number.isFinite(Number(it.paid))) return Number(it.paid);
  if (!catalog) return null;
  let e = it.catalogId ? catalog.byId.get(it.catalogId) : null;
  if (!e) {
    const k = fold(it.name);
    if (!k) return null;
    e = catalog.entries.find((x) => fold(x.item.name) === k || fold(x.item.nameFr) === k) || null;
  }
  if (!e) return null;
  const q = safeQuote(e.item, { rating: it.rating, grade: it.grade });
  const per = list === 'gear' ? Number(e.item.stats?.costFor) || 1 : 1;
  return Math.round((q.unitCost / per) * 100) / 100;
}
